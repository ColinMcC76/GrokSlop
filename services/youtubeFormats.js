/**
 * YouTube audio selection and lookup helpers with no runtime dependencies.
 * yt-dlp's default "best" audio can be an auto-dub (often French) when a
 * smaller dubbed track sorts ahead of the original. Prefer the original
 * track, then any audio.
 */

const YTDLP_FORMAT_SORT = 'lang,+abr';

const YTDLP_META_SEPARATOR = '\u001f';

const YTDLP_META_TEMPLATE = [
    '%(title)s',
    '%(duration)s',
    '%(id)s',
    '%(webpage_url,url)s',
].join(YTDLP_META_SEPARATOR);

function defaultAudioFormat() {
    return [
        'bestaudio[format_note*=original][ext=webm]',
        'bestaudio[format_note*=original][ext=m4a]',
        'bestaudio[format_note*=original]',
        'bestaudio[language_preference>=10][ext=webm]',
        'bestaudio[language_preference>=10][ext=m4a]',
        'bestaudio[language_preference>=10]',
        'bestaudio[ext=webm]',
        'bestaudio[ext=m4a]',
        'bestaudio',
        'best',
    ].join('/');
}

function m3u8AudioFormat() {
    return [
        'bestaudio[format_note*=original][protocol=m3u8_native]',
        'bestaudio[language_preference>=10][protocol=m3u8_native]',
        'bestaudio[protocol=m3u8_native]',
        'bestaudio[format_note*=original]',
        'bestaudio[language_preference>=10]',
        'bestaudio',
        'best',
    ].join('/');
}

function resolvedAudioFormat(override) {
    const custom = typeof override === 'string' ? override.trim() : '';
    return custom || defaultAudioFormat();
}

/**
 * @param {unknown} err
 */
function isHeaderOverflow(err) {
    const codes = [err?.code, err?.cause?.code, err?.error?.code];
    if (codes.includes('HPE_HEADER_OVERFLOW')) {
        return true;
    }
    const msg = String(err?.message || err || '');
    return /HPE_HEADER_OVERFLOW/i.test(msg) || /header overflow/i.test(msg);
}

/**
 * play-dl fails this way for every video once YouTube changes the watch page.
 * @param {unknown} err
 */
function isPlayDlPageParseError(err) {
    return /Initial Response Data is undefined/i.test(String(err?.message || err || ''));
}

/**
 * @param {unknown} err
 */
function playDlLookupIsBroken(err) {
    return isHeaderOverflow(err) || isPlayDlPageParseError(err);
}

function cleanMetaField(value) {
    const text = String(value ?? '').trim();
    if (!text || text === 'NA' || text === 'None') {
        return null;
    }
    return text;
}

/**
 * @param {string} stdout
 * @returns {{ url: string, title: string | null, durationInSec: number | null }[]}
 */
function parseYtdlpMetadata(stdout) {
    /** @type {{ url: string, title: string | null, durationInSec: number | null }[]} */
    const items = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        const parts = line.split(YTDLP_META_SEPARATOR);
        if (parts.length < 4) {
            continue;
        }
        const title = cleanMetaField(parts[0]);
        const durationRaw = cleanMetaField(parts[1]);
        const id = cleanMetaField(parts[2]);
        const pageUrl = cleanMetaField(parts.slice(3).join(YTDLP_META_SEPARATOR));
        const url =
            pageUrl && /^https?:\/\//i.test(pageUrl)
                ? pageUrl
                : id && /^[\w-]{11}$/.test(id)
                  ? `https://www.youtube.com/watch?v=${id}`
                  : null;
        if (!url) {
            continue;
        }
        const duration = Number(durationRaw);
        items.push({
            url,
            title,
            durationInSec: Number.isFinite(duration) && duration > 0 ? duration : null,
        });
    }
    return items;
}

function youtubeHostname(hostname) {
    const host = String(hostname || '')
        .replace(/^www\./i, '')
        .toLowerCase();
    return (
        host === 'youtu.be' ||
        host === 'youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'music.youtube.com' ||
        host.endsWith('.youtube.com')
    );
}

/**
 * @param {string} raw
 */
function isYouTubePlaylistUrl(raw) {
    try {
        const url = new URL(raw);
        if (!youtubeHostname(url.hostname)) {
            return false;
        }
        if (url.pathname === '/playlist' || url.pathname.startsWith('/playlist/')) {
            return true;
        }
        const list = url.searchParams.get('list');
        const videoId = url.searchParams.get('v');
        return Boolean(list) && !videoId;
    } catch {
        return false;
    }
}

/**
 * @param {string} raw
 */
function isYouTubeUrl(raw) {
    try {
        return youtubeHostname(new URL(raw).hostname);
    } catch {
        return false;
    }
}

/**
 * @param {string} query already trimmed
 * @returns {{ target: string, playlist: boolean }}
 */
function ytdlpLookupTarget(query) {
    if (isYouTubePlaylistUrl(query)) {
        return { target: query, playlist: true };
    }
    if (isYouTubeUrl(query)) {
        return { target: query, playlist: false };
    }
    return { target: `ytsearch1:${query}`, playlist: false };
}

/**
 * @param {unknown} playErr
 * @param {unknown} ytdlpErr
 */
function lookupFailure(playErr, ytdlpErr) {
    const ytdlpMsg = String(ytdlpErr?.message || ytdlpErr || '').trim();
    if (isHeaderOverflow(playErr)) {
        const extra = ytdlpMsg ? ` Backup lookup failed: ${ytdlpMsg}` : '';
        return new Error(
            `YouTube's reply was too large for Node (header overflow). Restart GrokSlop so it can raise the HTTP header limit.${extra}`
        );
    }
    if (ytdlpErr instanceof Error && ytdlpMsg) {
        return ytdlpErr;
    }
    if (ytdlpMsg) {
        return new Error(ytdlpMsg);
    }
    if (playErr instanceof Error) {
        return playErr;
    }
    return new Error('No YouTube results found.');
}

module.exports = {
    YTDLP_FORMAT_SORT,
    YTDLP_META_SEPARATOR,
    YTDLP_META_TEMPLATE,
    defaultAudioFormat,
    m3u8AudioFormat,
    resolvedAudioFormat,
    isHeaderOverflow,
    isPlayDlPageParseError,
    playDlLookupIsBroken,
    parseYtdlpMetadata,
    isYouTubePlaylistUrl,
    isYouTubeUrl,
    ytdlpLookupTarget,
    lookupFailure,
};
