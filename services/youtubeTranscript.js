const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const YT_VIDEO_ID_RE = /^[\w-]{11}$/;
const YTDLP_TIMEOUT_MS = 90_000;
const CAPTION_FETCH_MS = 20_000;
const PREFERRED_LANGS = [
    'en',
    'en-US',
    'en-GB',
    'en-orig',
    'en-CA',
    'en-AU',
];

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function spawnCollect(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${bin} timed out`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function ytdlpBin() {
    return process.env.YT_DLP_PATH?.trim() || 'yt-dlp';
}

function ytdlpCookieArgs() {
    const file = process.env.YT_DLP_COOKIES?.trim();
    if (file && fs.existsSync(file)) {
        return ['--cookies', file];
    }
    return [];
}

/**
 * @param {string} raw
 * @returns {string}
 */
function extractVideoId(raw) {
    const input = String(raw || '')
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        .trim()
        .replace(/^<([^>]+)>$/, '$1')
        .replace(/^['"`]+|['"`]+$/g, '')
        .trim();
    if (!input) {
        throw new Error('Paste a YouTube watch URL or 11-character video ID.');
    }
    if (YT_VIDEO_ID_RE.test(input)) {
        return input;
    }

    let url;
    try {
        url = new URL(input);
    } catch {
        throw new Error('Paste a YouTube watch URL or 11-character video ID.');
    }

    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        if (id && YT_VIDEO_ID_RE.test(id)) {
            return id;
        }
    }
    if (host === 'youtube.com' || host === 'music.youtube.com') {
        const v = url.searchParams.get('v');
        if (v && YT_VIDEO_ID_RE.test(v)) {
            return v;
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (
            (parts[0] === 'shorts' ||
                parts[0] === 'live' ||
                parts[0] === 'embed') &&
            parts[1] &&
            YT_VIDEO_ID_RE.test(parts[1])
        ) {
            return parts[1];
        }
    }
    throw new Error('Could not find a video ID in that YouTube URL.');
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Auto-captions repeat rolling phrases; keep extensions, drop duplicates.
 * @param {string[]} cues
 * @returns {string[]}
 */
function collapseRollingCues(cues) {
    /** @type {string[]} */
    const out = [];
    for (const raw of cues) {
        const cue = raw.replace(/\s+/g, ' ').trim();
        if (!cue) {
            continue;
        }
        if (out.length === 0) {
            out.push(cue);
            continue;
        }
        const prev = out[out.length - 1];
        if (cue === prev) {
            continue;
        }
        if (cue.startsWith(prev) && cue.length > prev.length) {
            out[out.length - 1] = cue;
            continue;
        }
        if (prev.endsWith(cue)) {
            continue;
        }
        out.push(cue);
    }
    return out;
}

/**
 * @param {string} vtt
 * @returns {string}
 */
function vttOrSrtToText(vtt) {
    const lines = String(vtt || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);
    const cues = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        if (
            t === 'WEBVTT' ||
            t.startsWith('Kind:') ||
            t.startsWith('Language:') ||
            t.startsWith('NOTE') ||
            t.startsWith('STYLE') ||
            /^\d+$/.test(t) ||
            /-->/.test(t)
        ) {
            continue;
        }
        const cleaned = decodeEntities(t.replace(/<[^>]+>/g, '')).trim();
        if (cleaned) {
            cues.push(cleaned);
        }
    }
    return collapseRollingCues(cues).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} json
 * @returns {string}
 */
function json3ToText(json) {
    const events = json && typeof json === 'object' ? json.events : null;
    if (!Array.isArray(events)) {
        return '';
    }
    const cues = [];
    for (const ev of events) {
        if (!ev || !Array.isArray(ev.segs)) {
            continue;
        }
        const line = ev.segs
            .map((seg) => (seg && seg.utf8 ? String(seg.utf8) : ''))
            .join('')
            .replace(/\n/g, ' ')
            .trim();
        if (line) {
            cues.push(decodeEntities(line));
        }
    }
    return collapseRollingCues(cues).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Record<string, Array<{ ext?: string, url?: string }>> | undefined} bucket
 * @param {'manual' | 'auto'} source
 */
function flattenTracks(bucket, source) {
    if (!bucket || typeof bucket !== 'object') {
        return [];
    }
    const tracks = [];
    for (const [lang, formats] of Object.entries(bucket)) {
        if (!Array.isArray(formats) || /live_chat/i.test(lang)) {
            continue;
        }
        for (const fmt of formats) {
            if (fmt && fmt.url) {
                tracks.push({
                    lang,
                    ext: String(fmt.ext || '').toLowerCase(),
                    url: fmt.url,
                    source,
                });
            }
        }
    }
    return tracks;
}

/**
 * @param {Array<{ lang: string, ext: string, url: string, source: string }>} tracks
 */
function pickBestTrack(tracks) {
    if (tracks.length === 0) {
        return null;
    }
    const extRank = { json3: 0, vtt: 1, srv3: 2, srt: 3, ttml: 4 };
    const scored = tracks.map((track) => {
        const langIndex = PREFERRED_LANGS.findIndex(
            (lang) => track.lang.toLowerCase() === lang.toLowerCase()
        );
        const enBonus = /^en\b/i.test(track.lang) ? 10 : 50;
        return {
            track,
            score:
                (track.source === 'manual' ? 0 : 20) +
                (langIndex >= 0 ? langIndex : enBonus) +
                (extRank[track.ext] ?? 9),
        };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0].track;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchCaptionBody(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'GrokSlop-YouTubeFeed/1.0', Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(CAPTION_FETCH_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching captions`);
    }
    return res.text();
}

/**
 * @param {string} body
 * @param {string} ext
 * @returns {string}
 */
function captionBodyToText(body, ext) {
    if (ext === 'json3' || ext === 'srv3') {
        try {
            return json3ToText(JSON.parse(body));
        } catch {
            return vttOrSrtToText(body);
        }
    }
    return vttOrSrtToText(body);
}

/**
 * @param {string} videoId
 * @returns {Promise<{ title?: string, tracks: ReturnType<typeof flattenTracks> }>}
 */
async function dumpYtdlpInfo(videoId) {
    const { code, stdout, stderr } = await spawnCollect(
        ytdlpBin(),
        [
            '--skip-download',
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            ...ytdlpCookieArgs(),
            `https://www.youtube.com/watch?v=${videoId}`,
        ],
        YTDLP_TIMEOUT_MS
    );
    if (code !== 0) {
        const hint =
            String(stderr || '')
                .split(/\r?\n/)
                .find((line) => /error/i.test(line)) ||
            `yt-dlp exited ${code}`;
        throw new Error(hint.slice(0, 240));
    }
    const info = JSON.parse(stdout);
    return {
        title: info.title || '',
        tracks: [
            ...flattenTracks(info.subtitles, 'manual'),
            ...flattenTracks(info.automatic_captions, 'auto'),
        ],
    };
}

/**
 * Last-resort: let yt-dlp write a sidecar caption file.
 * @param {string} videoId
 * @returns {Promise<string>}
 */
async function downloadSubsToText(videoId) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokslop-yt-sub-'));
    try {
        await spawnCollect(
            ytdlpBin(),
            [
                '--skip-download',
                '--write-subs',
                '--write-auto-subs',
                '--sub-langs',
                'en.*,en,-live_chat',
                '--sub-format',
                'vtt/srt/best',
                '--no-warnings',
                '--no-playlist',
                '--paths',
                workDir,
                '-o',
                `${videoId}.%(ext)s`,
                ...ytdlpCookieArgs(),
                `https://www.youtube.com/watch?v=${videoId}`,
            ],
            YTDLP_TIMEOUT_MS
        );
        const files = fs
            .readdirSync(workDir)
            .filter((name) => /\.(vtt|srt)$/i.test(name));
        if (files.length === 0) {
            return '';
        }
        files.sort();
        const body = fs.readFileSync(path.join(workDir, files[0]), 'utf8');
        return vttOrSrtToText(body);
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * @param {string} videoIdOrUrl
 * @returns {Promise<{ videoId: string, title: string, text: string, language: string, source: string }>}
 */
async function fetchYoutubeTranscript(videoIdOrUrl) {
    const videoId = extractVideoId(videoIdOrUrl);
    const info = await dumpYtdlpInfo(videoId);
    const track = pickBestTrack(info.tracks);

    if (track) {
        try {
            const body = await fetchCaptionBody(track.url);
            const text = captionBodyToText(body, track.ext);
            if (text) {
                return {
                    videoId,
                    title: info.title || '',
                    text,
                    language: track.lang,
                    source: track.source === 'manual' ? 'captions' : 'auto-captions',
                };
            }
        } catch {
            /* fall through to sidecar download */
        }
    }

    const downloaded = await downloadSubsToText(videoId);
    if (downloaded) {
        return {
            videoId,
            title: info.title || '',
            text: downloaded,
            language: 'en',
            source: 'auto-captions',
        };
    }

    const langs = [...new Set(info.tracks.map((t) => t.lang))].slice(0, 8);
    const extra = langs.length ? ` Available: ${langs.join(', ')}.` : '';
    throw new Error(`No usable captions on that video.${extra}`);
}

/**
 * @param {string} channelName
 * @param {string} videoId
 */
function transcriptFileName(channelName, videoId) {
    const slug =
        String(channelName || 'youtube')
            .replace(/[^\w]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'youtube';
    return `${slug}-${videoId}.txt`;
}

module.exports = {
    extractVideoId,
    fetchYoutubeTranscript,
    vttOrSrtToText,
    json3ToText,
    collapseRollingCues,
    transcriptFileName,
};
