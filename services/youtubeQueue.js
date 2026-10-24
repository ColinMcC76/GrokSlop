const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
} = require('@discordjs/voice');
const ffmpegStatic = require('ffmpeg-static');

/** @type {Map<string, GuildQueueState>} */
const queues = new Map();

/** @type {string | null} */
let cachedYtdlpVersion = null;

function getPlayDl() {
    try {
        return require('play-dl');
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND') {
            const err = new Error(
                'The **play-dl** package is missing. Open a terminal in your bot folder and run: `npm install` (then start the bot again).'
            );
            err.code = 'PLAY_DL_MISSING';
            throw err;
        }
        throw e;
    }
}

function isPlayDlInstalled() {
    try {
        require.resolve('play-dl');
        return true;
    } catch {
        return false;
    }
}

/**
 * @typedef {{ url: string, title: string | null, durationMs?: number | null, intro?: boolean, introUser?: string }} QueueItem
 * @typedef {{
 *   items: QueueItem[],
 *   player: import('@discordjs/voice').AudioPlayer,
 *   textChannel: import('discord.js').TextBasedChannel | null,
 *   generation: number,
 *   drainChain: Promise<void>,
 *   onPlayerError: (err: Error) => void,
 *   ytdlpChild: import('node:child_process').ChildProcess | null,
 *   volumePercent: number,
 *   startOffsetMs: number,
 *   cachedFile: { url: string, filePath: string } | null,
 * }} GuildQueueState
 */

const MAX_PLAYLIST_TRACKS = 25;
const SEEK_STEP_MS = 10_000;
const IDLE_WAIT_MS = 3_600_000;
const MAX_YTDLP_STDERR_BYTES = 128 * 1024;
const YT_CACHE_DIR = path.join(__dirname, '..', 'data', 'yt-cache');

function ytdlpBin() {
    return process.env.YT_DLP_PATH || 'yt-dlp';
}

function ytdlpBaseExtraArgs() {
    const args = [];
    const runtime = process.env.YT_DLP_JS_RUNTIME?.trim() || 'node';
    args.push('--js-runtimes', runtime);
    if (process.env.YT_DLP_REMOTE_COMPONENTS !== '0') {
        args.push('--remote-components', 'ejs:github');
    }
    const impersonate = process.env.YT_DLP_IMPERSONATE?.trim();
    if (impersonate) {
        args.push('--impersonate', impersonate);
    }
    return args;
}

/**
 * @param {string} extractorArgs
 */
function ytdlpProfileExtra(extractorArgs) {
    return ['--extractor-args', extractorArgs, ...ytdlpBaseExtraArgs()];
}

/**
 * @param {string[]} args
 * @param {number} timeoutMs
 */
function runYtdlpCollect(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = execFile(
            ytdlpBin(),
            args,
            {
                windowsHide: true,
                maxBuffer: 512 * 1024,
                timeout: timeoutMs,
            },
            (err, stdout, stderr) => {
                if (err) {
                    const msg =
                        ytdlpStderrError(String(stderr || '')) ||
                        err.message ||
                        String(err);
                    reject(new Error(msg));
                    return;
                }
                resolve({
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                });
            }
        );
        child.on('error', (spawnErr) => {
            if (spawnErr.code === 'ENOENT') {
                reject(
                    new Error(
                        'yt-dlp is not installed or not on PATH. Install from https://github.com/yt-dlp/yt-dlp — or set YT_DLP_PATH in .env.'
                    )
                );
                return;
            }
            reject(spawnErr);
        });
    });
}

async function logYtdlpVersionOnce() {
    if (cachedYtdlpVersion !== null) {
        return cachedYtdlpVersion;
    }
    try {
        const { stdout } = await runYtdlpCollect(['--version'], 10_000);
        cachedYtdlpVersion = stdout.trim();
        console.log(`[YouTube queue] yt-dlp ${cachedYtdlpVersion}`);
    } catch (e) {
        cachedYtdlpVersion = '';
        console.warn(
            '[YouTube queue] yt-dlp not available:',
            e?.message || e
        );
    }
    return cachedYtdlpVersion;
}

function deleteTempFile(filePath) {
    if (!filePath) {
        return;
    }
    try {
        fs.unlinkSync(filePath);
    } catch {}
}

/**
 * @param {import('@discordjs/voice').AudioResource<unknown>} resource
 * @param {number} percent 0–100
 */
function applyVolumeToResource(resource, percent) {
    if (!resource?.volume || typeof percent !== 'number') {
        return;
    }
    const linear = Math.max(0, Math.min(1, percent / 100));
    resource.volume.setVolume(linear);
}

/**
 * youtu.be and watch?v=…&list=… should play as a single video with a canonical URL.
 */
function normalizeYouTubeInput(raw) {
    const q = raw.trim();
    if (!q || !/^https?:\/\//i.test(q)) {
        return q;
    }
    try {
        const u = new URL(q);
        const host = u.hostname.replace(/^www\./, '');
        if (host === 'youtu.be') {
            const id = u.pathname.split('/').filter(Boolean)[0];
            if (id && /^[\w-]{11}$/.test(id)) {
                return `https://www.youtube.com/watch?v=${id}`;
            }
        }
        if (
            host === 'youtube.com' ||
            host === 'm.youtube.com' ||
            host === 'music.youtube.com'
        ) {
            const v = u.searchParams.get('v');
            if (v && /^[\w-]{11}$/.test(v)) {
                return `https://www.youtube.com/watch?v=${v}`;
            }
        }
    } catch {
        /* keep original */
    }
    return q;
}

/**
 * play.stream(url) can hit stream_from_info with a format missing .url (undeciphered).
 * video_info runs full decipher; stream_from_info uses that.
 */
async function createYoutubeStream(play, url) {
    let cachedInfo = null;
    const attempts = [
        async () => {
            cachedInfo = await play.video_info(url);
            return play.stream_from_info(cachedInfo, {
                discordPlayerCompatibility: true,
            });
        },
        async () => play.stream(url, { discordPlayerCompatibility: true }),
        async () => {
            const info = cachedInfo ?? (await play.video_info(url));
            return play.stream_from_info(info, {
                discordPlayerCompatibility: false,
            });
        },
        async () => play.stream(url, { discordPlayerCompatibility: false }),
    ];

    let lastErr;
    for (const run of attempts) {
        try {
            return await run();
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

/**
 * @typedef {{ name: string, format: string, extraArgs: string[] }} YtdlpProfile
 */

function defaultYtdlpFormat() {
    return (
        process.env.YT_DLP_FORMAT ||
        'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best/ba/b'
    );
}

/**
 * @returns {YtdlpProfile[]}
 */
function getYtdlpProfiles() {
    const defaultFormat = defaultYtdlpFormat();
    /** @type {YtdlpProfile[]} */
    const profiles = [];

    if (process.env.YT_DLP_EXTRACTOR_ARGS?.trim()) {
        profiles.push({
            name: 'custom',
            format: defaultFormat,
            extraArgs: ytdlpProfileExtra(process.env.YT_DLP_EXTRACTOR_ARGS.trim()),
        });
    }

    const cookieFile = process.env.YT_DLP_COOKIES?.trim();
    if (cookieFile) {
        profiles.push({
            name: 'cookies-file',
            format: defaultFormat,
            extraArgs: ytdlpProfileExtra(
                'youtube:player_client=default,-android_sdkless'
            ).concat(['--cookies', cookieFile]),
        });
    }

    profiles.push({
        name: 'web-actual-js',
        format: defaultFormat,
        extraArgs: ytdlpProfileExtra(
            'youtube:player_client=web,default,-android_sdkless;player_js_version=actual'
        ),
    });

    profiles.push({
        name: 'default',
        format: defaultFormat,
        extraArgs: ytdlpProfileExtra(
            'youtube:player_client=default,-android_sdkless'
        ),
    });

    profiles.push({
        name: 'android-vr',
        format: defaultFormat,
        extraArgs: ytdlpProfileExtra(
            'youtube:player_client=android_vr,default,-android_sdkless'
        ),
    });

    profiles.push({
        name: 'tv-embedded',
        format: defaultFormat,
        extraArgs: ytdlpProfileExtra(
            'youtube:player_client=tv_embedded,default,-android_sdkless'
        ),
    });

    profiles.push({
        name: 'm3u8-ios',
        format: 'ba[protocol=m3u8_native]/bestaudio[ext=m4a]/bestaudio/best',
        extraArgs: ytdlpProfileExtra(
            'youtube:player_client=default,ios,-android_sdkless;formats=missing_pot'
        ),
    });

    const cookieBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim();
    if (cookieBrowser && process.env.YT_DLP_SKIP_BROWSER_COOKIES !== '1') {
        profiles.push({
            name: `cookies-${cookieBrowser}`,
            format: defaultFormat,
            extraArgs: ytdlpProfileExtra(
                'youtube:player_client=default,-android_sdkless'
            ).concat(['--cookies-from-browser', cookieBrowser]),
        });
    }

    return profiles;
}

/**
 * @param {string} url
 * @param {YtdlpProfile} profile
 */
function formatYtSection(startMs) {
    const total = Math.max(0, Math.floor(startMs / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `*${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}-inf`;
}

function buildYtdlpArgs(url, profile, startMs = 0) {
    const args = [
        '-f',
        profile.format,
        '-S',
        '+abr',
        '-o',
        '-',
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
    ];
    if (startMs >= 1000) {
        args.push('--download-sections', formatYtSection(startMs));
    }
    args.push(...profile.extraArgs, url);
    return args;
}

function ytdlpStderrError(text) {
    if (!/ERROR:/i.test(text) && !/HTTP Error 403/i.test(text)) {
        return null;
    }
    return text.match(/ERROR:[^\n\r]+/i)?.[0]?.trim() || 'yt-dlp failed (HTTP 403)';
}

/**
 * YouTube breaks unofficial parsers often; yt-dlp is the reliable path (install separately).
 * Waits for real stdout data or a stderr error before resolving so fallbacks can run.
 * @param {string} url
 * @param {YtdlpProfile} profile
 * @returns {Promise<{ stream: import('node:stream').Readable, child: import('node:child_process').ChildProcess }>}
 */
function streamYoutubeViaYtdlp(url, profile, startMs = 0) {
    const bin = ytdlpBin();
    const args = buildYtdlpArgs(url, profile, startMs);

    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const stderrChunks = [];
        let stderrTotal = 0;
        let settled = false;
        const hangMs = 25_000;
        let hangTimer;

        const stderrText = () => Buffer.concat(stderrChunks).toString('utf8');

        const finishErr = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
            try {
                child.kill('SIGKILL');
            } catch {}
            reject(err);
        };

        const finishOk = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
            resolve({ stream: child.stdout, child });
        };

        const checkStderrForError = () => {
            const msg = ytdlpStderrError(stderrText());
            if (msg) {
                finishErr(new Error(msg));
                return true;
            }
            return false;
        };

        child.stderr.on('data', (chunk) => {
            if (stderrTotal < MAX_YTDLP_STDERR_BYTES) {
                stderrChunks.push(chunk);
                stderrTotal += chunk.length;
            }
            checkStderrForError();
        });

        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                err.message =
                    'yt-dlp is not installed or not on PATH. Install: https://github.com/yt-dlp/yt-dlp#installation — or set YT_DLP_PATH to the executable.';
            }
            finishErr(err);
        });

        child.on('close', (code, signal) => {
            const errText = stderrText().trim();
            if (code !== 0 && code !== null) {
                console.error(
                    '[YouTube queue] yt-dlp exited',
                    code,
                    signal || '',
                    profile.name,
                    errText ? errText.slice(0, 600) : ''
                );
            }
            if (!settled && code !== 0) {
                finishErr(
                    new Error(
                        ytdlpStderrError(errText) ||
                            `yt-dlp exited ${code ?? '?'} (${profile.name})`
                    )
                );
            }
        });

        hangTimer = setTimeout(() => {
            if (checkStderrForError()) {
                return;
            }
            finishErr(
                new Error(
                    `yt-dlp timed out after ${hangMs / 1000}s (${profile.name})`
                )
            );
        }, hangMs);
        if (typeof hangTimer.unref === 'function') {
            hangTimer.unref();
        }

        // Wait for stdout data before piping — do not use stdout.once('data') (consumes header).
        const onReadable = () => {
            if (child.stdout.readableLength > 0 && !checkStderrForError()) {
                child.stdout.off('readable', onReadable);
                finishOk();
            }
        };
        child.stdout.on('readable', onReadable);
    });
}

/**
 * @param {string} url
 * @param {YtdlpProfile} profile
 */
async function getYtdlpDirectUrl(url, profile) {
    const args = [
        '-g',
        '-f',
        profile.format,
        '--no-playlist',
        '--no-warnings',
        ...profile.extraArgs,
        url,
    ];
    const { stdout, stderr } = await runYtdlpCollect(args, 45_000);
    if (ytdlpStderrError(stderr)) {
        throw new Error(ytdlpStderrError(stderr));
    }
    const directUrl = stdout
        .trim()
        .split(/\r?\n/)
        .find((line) => /^https?:\/\//i.test(line));
    if (!directUrl) {
        throw new Error('yt-dlp -g returned no stream URL');
    }
    return directUrl;
}

/**
 * @param {string} directUrl
 */
function streamUrlViaFfmpeg(directUrl, startMs = 0) {
    if (!ffmpegStatic) {
        return Promise.reject(new Error('ffmpeg-static is not available'));
    }

    const args = [
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
    ];
    if (startMs >= 1000) {
        args.push('-ss', (startMs / 1000).toFixed(3));
    }
    args.push('-i', directUrl);

    return new Promise((resolve, reject) => {
        const child = spawn(
            ffmpegStatic,
            [
                ...args,
                '-vn',
                '-loglevel',
                'error',
                '-f',
                's16le',
                '-ar',
                '48000',
                '-ac',
                '2',
                'pipe:1',
            ],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            }
        );

        let settled = false;
        const stderrChunks = [];
        const hangMs = 25_000;
        let hangTimer;

        const finishErr = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
            try {
                child.kill('SIGKILL');
            } catch {}
            reject(err);
        };

        const finishOk = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
            resolve({ stream: child.stdout, child });
        };

        child.stderr.on('data', (chunk) => {
            stderrChunks.push(chunk);
        });

        child.on('error', finishErr);
        child.on('close', (code) => {
            if (!settled && code !== 0) {
                const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
                finishErr(new Error(errText || `ffmpeg exited ${code ?? '?'}`));
            }
        });

        hangTimer = setTimeout(() => {
            finishErr(new Error(`ffmpeg timed out after ${hangMs / 1000}s`));
        }, hangMs);
        hangTimer.unref?.();

        const onReadable = () => {
            if (child.stdout.readableLength > 0) {
                child.stdout.off('readable', onReadable);
                finishOk();
            }
        };
        child.stdout.on('readable', onReadable);
    });
}

/**
 * @param {string} url
 * @param {YtdlpProfile} profile
 */
async function downloadYoutubeViaYtdlp(url, profile) {
    fs.mkdirSync(YT_CACHE_DIR, { recursive: true });
    const stem = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outTemplate = path.join(YT_CACHE_DIR, `${stem}.%(ext)s`);
    const args = [
        '-f',
        profile.format,
        '-S',
        '+abr',
        '-o',
        outTemplate,
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        ...profile.extraArgs,
        url,
    ];

    await runYtdlpCollect(args, 120_000);

    const fileName = fs
        .readdirSync(YT_CACHE_DIR)
        .find((name) => name.startsWith(`${stem}.`));
    if (!fileName) {
        throw new Error('yt-dlp download produced no file');
    }
    return path.join(YT_CACHE_DIR, fileName);
}

/**
 * @param {string} url
 */
async function streamYoutubeWithFallbacks(url, options = {}) {
    await logYtdlpVersionOnce();
    const startMs = options.startMs || 0;

    const profiles = getYtdlpProfiles();
    const errors = [];

    for (const profile of profiles) {
        try {
            const result = await streamYoutubeViaYtdlp(url, profile, startMs);
            console.log(
                `[YouTube queue] streaming via yt-dlp pipe (${profile.name})`
            );
            return { ...result, mode: 'ytdlp-pipe' };
        } catch (err) {
            const msg = err?.message || String(err);
            errors.push(`${profile.name}: ${msg}`);
            console.warn(
                `[YouTube queue] yt-dlp pipe (${profile.name}) failed:`,
                msg
            );
        }
    }

    for (const profile of profiles) {
        try {
            const directUrl = await getYtdlpDirectUrl(url, profile);
            const result = await streamUrlViaFfmpeg(directUrl, startMs);
            console.log(
                `[YouTube queue] streaming via yt-dlp URL + ffmpeg (${profile.name})`
            );
            return { ...result, mode: 'ffmpeg-url' };
        } catch (err) {
            const msg = err?.message || String(err);
            errors.push(`url+ffmpeg ${profile.name}: ${msg}`);
            console.warn(
                `[YouTube queue] yt-dlp URL + ffmpeg (${profile.name}) failed:`,
                msg
            );
        }
    }

    for (const profile of profiles) {
        try {
            const filePath = await downloadYoutubeViaYtdlp(url, profile);
            console.log(
                `[YouTube queue] playing downloaded file (${profile.name})`
            );
            return { filePath, mode: 'ytdlp-file' };
        } catch (err) {
            const msg = err?.message || String(err);
            errors.push(`download ${profile.name}: ${msg}`);
            console.warn(
                `[YouTube queue] yt-dlp download (${profile.name}) failed:`,
                msg
            );
        }
    }

    const tail = errors.slice(-3).join(' | ');
    throw new Error(
        'YouTube playback failed. Update yt-dlp (`yt-dlp -U` or nightly), install Deno, ' +
            'export cookies.txt to YT_DLP_COOKIES (remove YT_DLP_COOKIES_FROM_BROWSER if you see DPAPI errors). ' +
            `See docs/youtube-playback.md. Last errors: ${tail}`
    );
}

function killYtdlpChild(state) {
    if (!state.ytdlpChild) return;
    try {
        state.ytdlpChild.kill('SIGKILL');
    } catch {}
    state.ytdlpChild = null;
}

function getOrCreateState(guildId, player) {
    let s = queues.get(guildId);
    if (!s) {
        const onPlayerError = (err) => {
            const code = err?.error?.code ?? err?.code;
            if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
                return;
            }
            console.error('[YouTube queue] AudioPlayer error:', err?.message || err);
        };
        player.on('error', onPlayerError);
        s = {
            items: [],
            player,
            textChannel: null,
            generation: 0,
            drainChain: Promise.resolve(),
            onPlayerError,
            ytdlpChild: null,
            volumePercent: 100,
            startOffsetMs: 0,
            cachedFile: null,
        };
        queues.set(guildId, s);
    }
    if (typeof s.volumePercent !== 'number' || Number.isNaN(s.volumePercent)) {
        s.volumePercent = 100;
    }
    s.player = player;
    return s;
}

function waitUntilIdle(player, gen, state) {
    return new Promise((resolve) => {
        const finish = () => {
            player.off('stateChange', onState);
            clearTimeout(timeout);
            resolve();
        };

        const onState = (_old, nw) => {
            if (state.generation !== gen) {
                finish();
                return;
            }
            if (nw.status === AudioPlayerStatus.Idle) {
                finish();
            }
        };

        if (state.generation !== gen) {
            resolve();
            return;
        }

        if (player.state.status === AudioPlayerStatus.Idle) {
            resolve();
            return;
        }

        player.on('stateChange', onState);

        const timeout = setTimeout(finish, IDLE_WAIT_MS);
    });
}

/**
 * @param {string} query
 * @returns {Promise<QueueItem[]>}
 */
async function resolveToQueueItems(query) {
    const play = getPlayDl();
    const q = query.trim();
    if (!q) {
        throw new Error('Empty query.');
    }

    const normalized = normalizeYouTubeInput(q);
    const validated = await play.validate(normalized).catch(() => false);
    const v = typeof validated === 'string' ? validated : '';

    if (v === 'yt_video') {
        const info = await play.video_basic_info(normalized);
        const title = info.video_details?.title || 'YouTube';
        return [queueItem(normalized, title, info.video_details?.durationInSec)];
    }

    if (v === 'yt_playlist') {
        const pl = await play.playlist_info(normalized, { incomplete: true });
        await pl.fetch();
        const videos = await pl.all_videos();
        return videos.slice(0, MAX_PLAYLIST_TRACKS).map((vid) => {
            return queueItem(vid.url, vid.title || 'YouTube', vid.durationInSec);
        });
    }

    const results = await play.search(normalized, {
        limit: 1,
        source: { youtube: 'video' },
    });
    if (!results.length) {
        throw new Error('No YouTube results found.');
    }
    const first = results[0];
    return [queueItem(first.url, first.title || q, first.durationInSec)];
}

function queueItem(url, title, durationInSec) {
    const seconds = Number(durationInSec);
    return {
        url,
        title: title || 'YouTube',
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    };
}

function queueFail(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function discardCachedFile(state) {
    if (state.cachedFile?.filePath) {
        deleteTempFile(state.cachedFile.filePath);
    }
    state.cachedFile = null;
}

function currentPositionMs(state) {
    if (!state || state.items.length === 0) {
        return 0;
    }
    const resource = state.player.state.resource;
    const played = Number.isFinite(resource?.playbackDuration) ? resource.playbackDuration : 0;
    return Math.max(0, (state.startOffsetMs || 0) + played);
}

function playerStatus(state) {
    const status = state?.player?.state?.status;
    if (status === AudioPlayerStatus.Playing) {
        return 'playing';
    }
    if (status === AudioPlayerStatus.Buffering) {
        return 'buffering';
    }
    if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
        return 'paused';
    }
    return 'idle';
}

function publicQueueItem(item) {
    return {
        title: item.title || 'YouTube',
        url: item.url || '',
        durationMs: item.durationMs || null,
    };
}

function openFileAt(filePath, startMs) {
    if (startMs < 1000 || !ffmpegStatic) {
        return Promise.resolve({
            resource: createAudioResource(filePath, { inlineVolume: true }),
            child: null,
        });
    }
    return new Promise((resolve, reject) => {
        const child = spawn(
            ffmpegStatic,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-ss',
                (startMs / 1000).toFixed(3),
                '-i',
                filePath,
                '-vn',
                '-f',
                's16le',
                '-ar',
                '48000',
                '-ac',
                '2',
                'pipe:1',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        let settled = false;
        const stderr = [];
        let timer;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                child.kill('SIGKILL');
            } catch {}
            reject(err);
        };
        timer = setTimeout(() => {
            fail(new Error('ffmpeg seek timed out'));
        }, 20_000);
        timer.unref?.();
        const ok = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                resource: createAudioResource(child.stdout, {
                    inputType: StreamType.Raw,
                    inlineVolume: true,
                }),
                child,
            });
        };
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', fail);
        child.on('close', (code) => {
            if (!settled && code) {
                const text = Buffer.concat(stderr).toString('utf8').trim();
                fail(new Error(text || `ffmpeg exited ${code}`));
            }
        });
        const onReadable = () => {
            if (child.stdout.readableLength > 0) {
                child.stdout.off('readable', onReadable);
                ok();
            }
        };
        child.stdout.on('readable', onReadable);
    });
}

function watchChild(state, child) {
    if (!child) return;
    state.ytdlpChild = child;
    child.on('close', () => {
        if (state.ytdlpChild === child) {
            state.ytdlpChild = null;
        }
    });
}

async function playCurrentTrack(state, options = {}) {
    const announce = options.announce !== false;
    const item = state.items[0];
    if (!item) {
        return;
    }

    const gen = state.generation;
    const startMs = Math.max(0, state.startOffsetMs || 0);
    killYtdlpChild(state);

    try {
        const resource = await openTrackResource(state, item, startMs, gen);
        if (!resource || state.generation !== gen) {
            return;
        }

        applyVolumeToResource(resource, state.volumePercent);
        state.player.play(resource);

        if (announce && state.textChannel) {
            try {
                if (item.intro) {
                    const who = item.introUser || 'Someone';
                    await state.textChannel.send(
                        `🎵 **${who}** rolled up with **${item.title}**`
                    );
                } else {
                    await state.textChannel.send(
                        `Now playing: **${item.title}**\n${item.url}`
                    );
                }
            } catch {}
        }

        await waitUntilIdle(state.player, gen, state);

        if (state.generation !== gen) {
            return;
        }

        finishTrack(state);
        await playNextFromQueue(state);
    } catch (err) {
        if (state.generation !== gen) {
            return;
        }
        killYtdlpChild(state);
        console.error('[YouTube queue] Playback failed:', err);
        if (state.textChannel) {
            try {
                await state.textChannel.send(
                    `Could not play **${item.title}**: ${err.message || err}\n` +
                        'If this is a YouTube 403 error, update yt-dlp (`yt-dlp -U`) and restart the bot. See `docs/youtube-playback.md`.'
                );
            } catch {}
        }
        finishTrack(state);
        await playNextFromQueue(state);
    }
}

async function openTrackResource(state, item, startMs, gen) {
    if (state.cachedFile?.url === item.url && fs.existsSync(state.cachedFile.filePath)) {
        const opened = await openFileAt(state.cachedFile.filePath, startMs);
        if (state.generation !== gen) {
            if (opened.child) {
                try {
                    opened.child.kill('SIGKILL');
                } catch {}
            }
            return null;
        }
        watchChild(state, opened.child);
        return opened.resource;
    }

    const streamed = await streamYoutubeWithFallbacks(item.url, { startMs });
    if (state.generation !== gen) {
        if (streamed.filePath) {
            deleteTempFile(streamed.filePath);
        }
        if (streamed.child) {
            try {
                streamed.child.kill('SIGKILL');
            } catch {}
        }
        return null;
    }

    if (streamed.mode === 'ytdlp-file' && streamed.filePath) {
        if (state.cachedFile?.filePath && state.cachedFile.filePath !== streamed.filePath) {
            deleteTempFile(state.cachedFile.filePath);
        }
        state.cachedFile = { url: item.url, filePath: streamed.filePath };
        if (startMs >= 1000) {
            const opened = await openFileAt(streamed.filePath, startMs);
            if (state.generation !== gen) {
                if (opened.child) {
                    try {
                        opened.child.kill('SIGKILL');
                    } catch {}
                }
                return null;
            }
            watchChild(state, opened.child);
            return opened.resource;
        }
        return createAudioResource(streamed.filePath, {
            inlineVolume: true,
            metadata: { title: item.title, url: item.url },
        });
    }

    if (streamed.stream) {
        watchChild(state, streamed.child);
        return createAudioResource(streamed.stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            metadata: { title: item.title, url: item.url },
        });
    }

    throw new Error('No YouTube stream source available.');
}

function finishTrack(state) {
    state.items.shift();
    state.startOffsetMs = 0;
    killYtdlpChild(state);
    if (!state.items[0] || state.cachedFile?.url !== state.items[0].url) {
        discardCachedFile(state);
    }
}

async function playNextFromQueue(state) {
    if (state.items.length === 0) {
        return;
    }
    await playCurrentTrack(state);
}

/**
 * Serializes playback; swallows rejections so a rare failure cannot brick later enqueues.
 * @param {GuildQueueState} state
 * @param {() => Promise<void>} fn
 */
function chainDrain(state, fn) {
    state.drainChain = state.drainChain
        .catch(() => {})
        .then(fn)
        .catch(() => {});
}

/**
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {import('discord.js').TextBasedChannel | null} textChannel
 * @param {string} query
 */
async function enqueue(guildId, player, textChannel, query) {
    const state = getOrCreateState(guildId, player);
    if (textChannel) {
        state.textChannel = textChannel;
    }

    const items = await resolveToQueueItems(query);
    const wasEmpty = state.items.length === 0;
    state.items.push(...items);

    if (wasEmpty && state.player.state.status === AudioPlayerStatus.Idle) {
        chainDrain(state, () => playCurrentTrack(state));
    }

    return { added: items.length, titles: items.map((i) => i.title) };
}

/**
 * Resolve a single YouTube track (search, URL, or first video from a playlist link).
 * @param {string} query
 * @returns {Promise<QueueItem>}
 */
async function resolveSingleTrack(query) {
    const items = await resolveToQueueItems(query);
    if (!items.length) {
        throw new Error('No YouTube results found.');
    }
    return items[0];
}

/**
 * Queue an intro at the front — interrupts current playback if needed.
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {import('discord.js').TextBasedChannel | null} textChannel
 * @param {string} query
 * @param {{ displayName?: string }} [meta]
 */
async function enqueueIntro(guildId, player, textChannel, query, meta = {}) {
    const state = getOrCreateState(guildId, player);
    if (textChannel) {
        state.textChannel = textChannel;
    }

    const track = await resolveSingleTrack(query);
    track.intro = true;
    track.introUser = meta.displayName || 'Someone';

    state.items.unshift(track);

    if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.generation += 1;
        killYtdlpChild(state);
        try {
            state.player.stop(true);
        } catch {}
    }

    chainDrain(state, () => playCurrentTrack(state));

    return { title: track.title, url: track.url };
}

/**
 * Play a resolved queue item as an intro (already stored URL/search).
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {import('discord.js').TextBasedChannel | null} textChannel
 * @param {QueueItem} track
 * @param {{ displayName?: string }} [meta]
 */
function enqueueIntroTrack(guildId, player, textChannel, track, meta = {}) {
    const state = getOrCreateState(guildId, player);
    if (textChannel) {
        state.textChannel = textChannel;
    }

    const item = {
        url: track.url,
        title: track.title,
        intro: true,
        introUser: meta.displayName || 'Someone',
    };
    state.items.unshift(item);

    if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.generation += 1;
        killYtdlpChild(state);
        try {
            state.player.stop(true);
        } catch {}
    }

    chainDrain(state, () => playCurrentTrack(state));

    return { title: item.title, url: item.url };
}

/**
 * Stop the current YouTube resource without dropping it from the queue,
 * so a soundbite can use the same voice player. Resolves true when a track
 * should be started again afterwards.
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
function suspendForExternalAudio(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return Promise.resolve(false);
    }
    state.startOffsetMs = currentPositionMs(state);
    state.generation += 1;
    killYtdlpChild(state);
    try {
        state.player.stop(true);
    } catch {}
    return state.drainChain.catch(() => {}).then(() => state.items.length > 0);
}

/**
 * Restart the current queued track after a soundbite, if one is still queued.
 * @param {string} guildId
 */
function resumeAfterExternalAudio(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return;
    }
    if (state.player.state.status !== AudioPlayerStatus.Idle) {
        return;
    }
    chainDrain(state, () => playCurrentTrack(state, { announce: false }));
}

/**
 * Start playback if queue has items but player is idle (e.g. after /talkoff).
 */
function ensurePlaying(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return;
    }
    if (state.player.state.status !== AudioPlayerStatus.Idle) {
        return;
    }
    chainDrain(state, () => playCurrentTrack(state));
}

function skip(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return false;
    }
    state.generation += 1;
    state.startOffsetMs = 0;
    killYtdlpChild(state);
    try {
        state.player.stop(true);
    } catch {}
    state.items.shift();
    if (!state.items[0] || state.cachedFile?.url !== state.items[0].url) {
        discardCachedFile(state);
    }
    chainDrain(state, () => playNextFromQueue(state));
    return true;
}

function stopAndClear(guildId) {
    const state = queues.get(guildId);
    if (!state) {
        return false;
    }
    state.generation += 1;
    state.startOffsetMs = 0;
    killYtdlpChild(state);
    state.items.length = 0;
    discardCachedFile(state);
    try {
        state.player.stop(true);
    } catch {}
    return true;
}

function removeGuild(guildId) {
    const state = queues.get(guildId);
    if (!state) {
        return;
    }
    state.generation += 1;
    state.startOffsetMs = 0;
    killYtdlpChild(state);
    state.items.length = 0;
    discardCachedFile(state);
    try {
        state.player.off('error', state.onPlayerError);
    } catch {}
    try {
        state.player.stop(true);
    } catch {}
    queues.delete(guildId);
}

function queueLength(guildId) {
    return queues.get(guildId)?.items.length ?? 0;
}

/**
 * @param {string} guildId
 * @returns {{ current: QueueItem | null, upcoming: QueueItem[], total: number }}
 */
function getQueueSnapshot(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return { current: null, upcoming: [], total: 0 };
    }
    const [current, ...rest] = state.items;
    return {
        current,
        upcoming: rest,
        total: state.items.length,
    };
}

/**
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {number} percent 0–100, step 5
 * @returns {number} applied percent
 */
function setYoutubeVolume(guildId, player, percent) {
    if (
        typeof percent !== 'number' ||
        percent < 0 ||
        percent > 100 ||
        percent % 5 !== 0
    ) {
        throw new Error('Volume must be between 0 and 100 in steps of 5.');
    }
    const state = getOrCreateState(guildId, player);
    state.volumePercent = percent;
    const res = state.player.state.resource;
    if (res) {
        applyVolumeToResource(res, percent);
    }
    return percent;
}

/**
 * @param {string} guildId
 * @returns {number}
 */
function getYoutubeVolume(guildId) {
    const s = queues.get(guildId);
    const p = s?.volumePercent;
    return typeof p === 'number' && !Number.isNaN(p) ? p : 100;
}

function emptyQueueView() {
    return {
        status: 'idle',
        positionMs: 0,
        durationMs: null,
        current: null,
        upcoming: [],
        total: 0,
    };
}

function getQueueView(guildId) {
    const state = queues.get(guildId);
    const snap = getQueueSnapshot(guildId);
    if (!snap.current) {
        return emptyQueueView();
    }
    const status = playerStatus(state);
    return {
        status,
        positionMs: status === 'idle' ? 0 : currentPositionMs(state),
        durationMs: snap.current.durationMs || null,
        current: publicQueueItem(snap.current),
        upcoming: snap.upcoming.map((item, index) => ({
            ...publicQueueItem(item),
            index,
        })),
        total: snap.total,
    };
}

function pausePlayback(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        throw queueFail('Nothing is playing or queued.');
    }
    const status = playerStatus(state);
    if (status === 'paused') {
        return getQueueView(guildId);
    }
    if (status !== 'playing') {
        throw queueFail(
            status === 'buffering'
                ? 'The track is still buffering. Try again in a moment.'
                : 'Nothing is playing.'
        );
    }
    if (!state.player.pause(true)) {
        throw queueFail('The track is still buffering. Try again in a moment.');
    }
    return getQueueView(guildId);
}

function resumePlayback(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        throw queueFail('Nothing is queued.');
    }
    const status = playerStatus(state);
    if (status === 'paused') {
        if (state.player.state.status === AudioPlayerStatus.Paused) {
            state.player.unpause();
        }
        return getQueueView(guildId);
    }
    if (status === 'idle') {
        chainDrain(state, () => playCurrentTrack(state, { announce: false }));
    }
    return getQueueView(guildId);
}

function seekPlayback(guildId, positionMs) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        throw queueFail('Nothing is playing or queued.');
    }
    const duration = state.items[0].durationMs;
    let target = Math.max(0, Math.round(Number(positionMs) || 0));
    if (Math.abs(target - currentPositionMs(state)) < 400) {
        return getQueueView(guildId);
    }
    if (duration && target >= duration - 400) {
        skip(guildId);
        return getQueueView(guildId);
    }
    state.startOffsetMs = target;
    state.generation += 1;
    killYtdlpChild(state);
    try {
        state.player.unpause();
    } catch {}
    try {
        state.player.stop(true);
    } catch {}
    chainDrain(state, () => playCurrentTrack(state, { announce: false }));
    return getQueueView(guildId);
}

function seekBy(guildId, deltaMs) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        throw queueFail('Nothing is playing or queued.');
    }
    return seekPlayback(guildId, currentPositionMs(state) + deltaMs);
}

function removeUpcoming(guildId, index) {
    const state = queues.get(guildId);
    if (!state || state.items.length < 2) {
        throw queueFail('Nothing else is queued.');
    }
    const at = Number(index) + 1;
    if (!Number.isInteger(at) || at < 1 || at >= state.items.length) {
        throw queueFail('That queued song is not there.');
    }
    state.items.splice(at, 1);
    return getQueueView(guildId);
}

module.exports = {
    enqueue,
    enqueueIntro,
    enqueueIntroTrack,
    resolveSingleTrack,
    skip,
    stopAndClear,
    removeGuild,
    queueLength,
    getQueueSnapshot,
    ensurePlaying,
    suspendForExternalAudio,
    resumeAfterExternalAudio,
    isPlayDlInstalled,
    setYoutubeVolume,
    getYoutubeVolume,
    getQueueView,
    pausePlayback,
    resumePlayback,
    seekPlayback,
    seekBy,
    removeUpcoming,
    SEEK_STEP_MS,
};
