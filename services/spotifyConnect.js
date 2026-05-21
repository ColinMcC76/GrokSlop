const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const ffmpegStatic = require('ffmpeg-static');
const {
    getValidAccessToken,
    getGuildSpotifyRow,
    defaultDeviceName,
} = require('./spotifyAuth');

const LIBRESPOT_BIN = process.env.LIBRESPOT_PATH || 'librespot';
/** librespot 0.8+ uses --access-token (-k), not --token */
const TOKEN_FLAG = process.env.LIBRESPOT_TOKEN_FLAG || '--access-token';
const PCM_RATE = Number(process.env.SPOTIFY_PCM_RATE) || 44100;
const PCM_CHANNELS = 2;

/**
 * @typedef {'standby' | 'discord'} ConnectMode
 * @typedef {{
 *   librespot: import('node:child_process').ChildProcess,
 *   ffmpeg: import('node:child_process').ChildProcess | null,
 *   discard: import('node:stream').Writable | null,
 *   mode: ConnectMode,
 *   tokenRefreshTimer: NodeJS.Timeout | null,
 *   player: import('@discordjs/voice').AudioPlayer | null,
 *   playerErrorHandler: ((err: unknown) => void) | null,
 *   playerStateHandler: ((old: unknown, nw: unknown) => void) | null,
 *   pipeUnpipe: (() => void) | null,
 *   restartingFfmpeg: boolean,
 *   lastLog: string,
 *   startedAt: number,
 * }} GuildSpotifyRuntime
 */

/** @type {Map<string, GuildSpotifyRuntime>} */
const runtimes = new Map();

function isBenignStreamError(err) {
    if (!err) {
        return false;
    }
    const code = err.code ?? err.errno;
    return (
        code === 'EPIPE' ||
        code === 'ECONNRESET' ||
        code === 'ERR_STREAM_DESTROYED' ||
        code === 'ERR_STREAM_PREMATURE_CLOSE'
    );
}

/**
 * @param {import('node:stream').Readable | import('node:stream').Writable} stream
 * @param {string} label
 */
function guardStreamErrors(stream, label) {
    stream.on('error', (err) => {
        if (isBenignStreamError(err)) {
            return;
        }
        console.warn(`[spotify] ${label}:`, err?.message || err);
    });
}

/**
 * @param {import('node:stream').Readable} src
 * @param {import('node:stream').Writable} dest
 */
function safePipe(src, dest) {
    guardStreamErrors(src, 'pipe src');
    guardStreamErrors(dest, 'pipe dest');
    src.pipe(dest);

    const onSrcError = (err) => {
        if (isBenignStreamError(err)) {
            try {
                src.unpipe(dest);
            } catch {}
        }
    };
    const onDestError = (err) => {
        if (isBenignStreamError(err)) {
            try {
                src.unpipe(dest);
            } catch {}
        }
    };
    src.on('error', onSrcError);
    dest.on('error', onDestError);

    return () => {
        try {
            src.unpipe(dest);
        } catch {}
        src.off('error', onSrcError);
        dest.off('error', onDestError);
    };
}

function createDiscardSink() {
    const sink = new Writable({
        write(_chunk, _enc, cb) {
            cb();
        },
    });
    guardStreamErrors(sink, 'discard sink');
    return sink;
}

function cacheDir(guildId) {
    const dir = path.join(__dirname, '..', 'data', 'spotify', guildId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * @param {string} guildId
 */
function isLinked(guildId) {
    return Boolean(getGuildSpotifyRow(guildId));
}

/**
 * @param {string} guildId
 */
function isActive(guildId) {
    const rt = runtimes.get(guildId);
    return Boolean(rt?.librespot && rt.librespot.exitCode == null);
}

/**
 * @param {string} guildId
 */
function getConnectMode(guildId) {
    return runtimes.get(guildId)?.mode ?? null;
}

/**
 * @param {string} guildId
 */
function getDiagnostics(guildId) {
    const rt = runtimes.get(guildId);
    return {
        librespotPath: LIBRESPOT_BIN,
        active: isActive(guildId),
        mode: rt?.mode ?? null,
        lastLog: rt?.lastLog ?? null,
        deviceName: getGuildSpotifyRow(guildId)?.device_name || defaultDeviceName(),
    };
}

function killChild(child) {
    if (!child || child.killed) {
        return;
    }
    try {
        child.kill('SIGKILL');
    } catch {}
}

/**
 * @param {GuildSpotifyRuntime} rt
 */
function tearDownPipes(rt) {
    if (rt.pipeUnpipe) {
        try {
            rt.pipeUnpipe();
        } catch {}
        rt.pipeUnpipe = null;
    }
    try {
        rt.librespot?.stdout?.unpipe();
    } catch {}
    try {
        rt.discard?.destroy();
    } catch {}
    rt.discard = null;
}

/**
 * @param {string} guildId
 * @param {boolean} [unlink]
 */
async function stopGuild(guildId, unlink = false) {
    const rt = runtimes.get(guildId);
    if (rt) {
        if (rt.tokenRefreshTimer) {
            clearInterval(rt.tokenRefreshTimer);
        }
        if (rt.playerErrorHandler && rt.player) {
            try {
                rt.player.off('error', rt.playerErrorHandler);
            } catch {}
        }
        if (rt.playerStateHandler && rt.player) {
            try {
                rt.player.off('stateChange', rt.playerStateHandler);
            } catch {}
        }
        tearDownPipes(rt);
        killChild(rt.ffmpeg);
        killChild(rt.librespot);
        runtimes.delete(guildId);
    }

    if (unlink) {
        const { removeGuildSpotify } = require('./spotifyAuth');
        removeGuildSpotify(guildId);
        try {
            fs.rmSync(cacheDir(guildId), { recursive: true, force: true });
        } catch {}
    }
}

/**
 * @param {string} guildId
 * @param {string} accessToken
 * @param {string} deviceName
 */
function buildLibrespotArgs(guildId, accessToken, deviceName) {
    return [
        '--name',
        deviceName,
        '--device-type',
        'speaker',
        '--backend',
        'pipe',
        '--format',
        's16',
        '--bitrate',
        '320',
        '--cache',
        cacheDir(guildId),
        '--disable-discovery',
        TOKEN_FLAG,
        accessToken,
    ];
}

/**
 * @param {string} guildId
 * @param {GuildSpotifyRuntime} rt
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
function startDiscordFfmpeg(guildId, rt, player) {
    if (!ffmpegStatic) {
        throw new Error('ffmpeg-static is missing; cannot pipe Spotify audio to Discord.');
    }

    tearDownPipes(rt);
    killChild(rt.ffmpeg);
    rt.ffmpeg = null;

    const ffmpeg = spawn(
        ffmpegStatic,
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            's16le',
            '-ar',
            String(PCM_RATE),
            '-ac',
            String(PCM_CHANNELS),
            '-i',
            'pipe:0',
            '-f',
            's16le',
            '-ar',
            '48000',
            '-ac',
            '2',
            'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    rt.ffmpeg = ffmpeg;
    guardStreamErrors(ffmpeg.stdin, `${guildId} ffmpeg stdin`);
    guardStreamErrors(ffmpeg.stdout, `${guildId} ffmpeg stdout`);

    rt.pipeUnpipe = safePipe(rt.librespot.stdout, ffmpeg.stdin);

    ffmpeg.stderr.on('data', (chunk) => {
        const t = chunk.toString().trim();
        if (t) {
            console.warn(`[spotify:${guildId}] ffmpeg:`, t.slice(0, 300));
        }
    });

    ffmpeg.on('error', (err) => {
        if (isBenignStreamError(err)) {
            return;
        }
        console.error(`[spotify:${guildId}] ffmpeg error:`, err);
    });

    ffmpeg.once('close', (code) => {
        console.log(`[spotify:${guildId}] ffmpeg exited`, code);
        const current = runtimes.get(guildId);
        if (!current || current.ffmpeg !== ffmpeg) {
            return;
        }
        current.ffmpeg = null;
        if (current.pipeUnpipe) {
            try {
                current.pipeUnpipe();
            } catch {}
            current.pipeUnpipe = null;
        }

        if (
            current.mode === 'discord' &&
            current.librespot &&
            current.librespot.exitCode == null &&
            !current.restartingFfmpeg
        ) {
            scheduleFfmpegRestart(guildId, current, player);
            return;
        }

        if (current.librespot && current.librespot.exitCode == null) {
            killChild(current.librespot);
        }
        if (current === runtimes.get(guildId)) {
            if (current.tokenRefreshTimer) {
                clearInterval(current.tokenRefreshTimer);
            }
            runtimes.delete(guildId);
        }
    });

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        silencePaddingFrames: 5,
    });

    if (!rt.playerErrorHandler) {
        rt.player = player;
        rt.playerErrorHandler = (err) => {
            const code = err?.error?.code ?? err?.code;
            if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'EPIPE') {
                return;
            }
            console.error(
                `[spotify:${guildId}] AudioPlayer:`,
                err?.message || err
            );
        };
        player.on('error', rt.playerErrorHandler);
    }

    player.play(resource);
}

/**
 * @param {string} guildId
 * @param {GuildSpotifyRuntime} rt
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
function scheduleFfmpegRestart(guildId, rt, player) {
    if (rt.restartingFfmpeg) {
        return;
    }
    rt.restartingFfmpeg = true;
    setTimeout(() => {
        rt.restartingFfmpeg = false;
        const current = runtimes.get(guildId);
        if (
            !current ||
            current.mode !== 'discord' ||
            !current.librespot ||
            current.librespot.exitCode != null
        ) {
            return;
        }
        try {
            console.log(`[spotify:${guildId}] restarting ffmpeg pipeline`);
            startDiscordFfmpeg(guildId, current, player);
        } catch (e) {
            console.error(`[spotify:${guildId}] ffmpeg restart failed:`, e);
        }
    }, 300);
}

/**
 * @param {import('node:child_process').ChildProcess} librespot
 * @param {GuildSpotifyRuntime} rt
 */
function wireLibrespotLogs(guildId, librespot, rt) {
    librespot.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (!line) {
            return;
        }
        rt.lastLog = line.slice(0, 500);
        console.log(`[spotify:${guildId}]`, rt.lastLog);
    });

    librespot.on('error', (err) => {
        rt.lastLog = err.message || String(err);
        if (err.code === 'ENOENT') {
            console.error(
                `[spotify:${guildId}] librespot not found at "${LIBRESPOT_BIN}". ` +
                    'Windows: build librespot.exe (see docs/librespot-windows.md) and set LIBRESPOT_PATH in .env.'
            );
        } else {
            console.error(`[spotify:${guildId}] librespot error:`, err);
        }
    });
}

/**
 * @param {string} guildId
 * @param {ConnectMode} mode
 * @param {import('@discordjs/voice').AudioPlayer} [player]
 */
async function startSession(guildId, mode, player) {
    if (!isLinked(guildId)) {
        throw new Error('Spotify is not linked for this server.');
    }

    const existing = runtimes.get(guildId);
    if (existing?.mode === mode && isActive(guildId)) {
        if (mode === 'discord' && player && existing.ffmpeg) {
            return;
        }
        if (mode === 'standby') {
            return;
        }
    }

    if (isActive(guildId)) {
        await stopGuild(guildId, false);
    }

    const row = getGuildSpotifyRow(guildId);
    const accessToken = await getValidAccessToken(guildId);
    const deviceName = row?.device_name || defaultDeviceName();
    const args = buildLibrespotArgs(guildId, accessToken, deviceName);

    const librespot = spawn(LIBRESPOT_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const rt = {
        librespot,
        ffmpeg: null,
        discard: null,
        mode,
        player: player ?? null,
        tokenRefreshTimer: null,
        playerErrorHandler: null,
        playerStateHandler: null,
        pipeUnpipe: null,
        restartingFfmpeg: false,
        lastLog: '',
        startedAt: Date.now(),
    };
    runtimes.set(guildId, rt);
    wireLibrespotLogs(guildId, librespot, rt);

    guardStreamErrors(librespot.stdout, `${guildId} librespot stdout`);

    if (mode === 'standby') {
        rt.discard = createDiscardSink();
        rt.pipeUnpipe = safePipe(librespot.stdout, rt.discard);
    } else {
        if (!player) {
            killChild(librespot);
            runtimes.delete(guildId);
            throw new Error('Discord player is required for voice output.');
        }
        rt.player = player;
        try {
            startDiscordFfmpeg(guildId, rt, player);
        } catch (e) {
            killChild(librespot);
            runtimes.delete(guildId);
            throw e;
        }
    }

    const onDead = () => {
        const current = runtimes.get(guildId);
        if (current?.librespot === librespot) {
            if (current.tokenRefreshTimer) {
                clearInterval(current.tokenRefreshTimer);
            }
            runtimes.delete(guildId);
        }
    };

    librespot.on('close', (code) => {
        console.log(`[spotify:${guildId}] librespot exited`, code);
        onDead();
    });

    await new Promise((resolve, reject) => {
        const failMs = 12_000;
        let settled = false;

        const finish = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            librespot.off('close', onEarlyClose);
            librespot.stderr.off('data', checkReady);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        const timer = setTimeout(() => {
            if (isActive(guildId)) {
                finish();
            } else {
                finish(
                    new Error(
                        rt.lastLog ||
                            'librespot did not stay running. Install librespot and check the bot console.'
                    )
                );
            }
        }, failMs);

        const onEarlyClose = (code) => {
            finish(
                new Error(
                    rt.lastLog ||
                        `librespot exited during startup (code ${code ?? '?'}).`
                )
            );
        };
        librespot.once('close', onEarlyClose);

        const checkReady = (chunk) => {
            const line = chunk.toString();
            if (
                /authenticated|ready|logged in|session/i.test(line) &&
                isActive(guildId)
            ) {
                finish();
            }
        };
        librespot.stderr.on('data', checkReady);
    });

    console.log(
        `[spotify:${guildId}] Connect device "${deviceName}" (${mode}) — should appear in the Spotify app`
    );

    rt.tokenRefreshTimer = setInterval(async () => {
        try {
            if (!isActive(guildId)) {
                return;
            }
            const rowNow = getGuildSpotifyRow(guildId);
            if (!rowNow || rowNow.expires_at > Date.now() + 10 * 60 * 1000) {
                return;
            }
            await getValidAccessToken(guildId);
            const modeNow = getConnectMode(guildId) || 'standby';
            const { getConnectionData } = require('./voiceManager');
            const data = getConnectionData(guildId);
            console.log(`[spotify:${guildId}] restarting after token refresh`);
            await stopGuild(guildId, false);
            if (modeNow === 'discord' && data?.player) {
                await startSession(guildId, 'discord', data.player);
            } else {
                await startSession(guildId, 'standby');
            }
        } catch (e) {
            console.error(`[spotify:${guildId}] token refresh:`, e);
        }
    }, 5 * 60 * 1000);
    if (typeof rt.tokenRefreshTimer.unref === 'function') {
        rt.tokenRefreshTimer.unref();
    }
}

/**
 * Start librespot so the device shows in Spotify Connect (no Discord audio yet).
 * @param {string} guildId
 */
async function ensureConnectDevice(guildId) {
    await startSession(guildId, 'standby');
}

/**
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
async function startDiscordOutput(guildId, player) {
    await startSession(guildId, 'discord', player);
}

/**
 * @param {string} guildId
 */
async function stopDiscordOutput(guildId) {
    if (!isActive(guildId)) {
        return;
    }
    if (getConnectMode(guildId) === 'discord' && isLinked(guildId)) {
        await startSession(guildId, 'standby');
    } else if (isActive(guildId)) {
        await stopGuild(guildId, false);
    }
}

/**
 * @param {string} guildId
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
async function attachIfLinkedInVoice(guildId, player) {
    if (!isLinked(guildId)) {
        return;
    }
    const { isRealtimeActive } = require('./realtimeVoiceBridge');
    if (isRealtimeActive(guildId)) {
        return;
    }
    await startDiscordOutput(guildId, player);
}

module.exports = {
    ensureConnectDevice,
    startDiscordOutput,
    stopDiscordOutput,
    attachIfLinkedInVoice,
    stopGuild,
    isLinked,
    isActive,
    getConnectMode,
    getDiagnostics,
};
