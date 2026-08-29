const { spawn } = require('node:child_process');
const { Writable, PassThrough } = require('node:stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const ffmpegStatic = require('ffmpeg-static');
const {
    getGuildSpotifyRow,
    defaultDeviceName,
} = require('./spotifyAuth');
const {
    audioCacheDir,
    systemCacheDir,
    hasLibrespotCredentials,
    clearLibrespotCache,
} = require('./spotifyLibrespotOAuth');

const LIBRESPOT_BIN = process.env.LIBRESPOT_PATH || 'librespot';
const PCM_RATE = Number(process.env.SPOTIFY_PCM_RATE) || 44100;
const PCM_CHANNELS = 2;

/**
 * @typedef {'standby' | 'discord'} ConnectMode
 * @typedef {{
 *   librespot: import('node:child_process').ChildProcess,
 *   ffmpeg: import('node:child_process').ChildProcess | null,
 *   discard: import('node:stream').Writable | null,
 *   pcmBridge: import('node:stream').PassThrough | null,
 *   mode: ConnectMode,
 *   tokenRefreshTimer: NodeJS.Timeout | null,
 *   player: import('@discordjs/voice').AudioPlayer | null,
 *   playerErrorHandler: ((err: unknown) => void) | null,
 *   playerStateHandler: ((old: unknown, nw: unknown) => void) | null,
 *   librespotPipeUnpipe: (() => void) | null,
 *   sinkPipeUnpipe: (() => void) | null,
 *   ffmpegPipeUnpipe: (() => void) | null,
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
/**
 * @param {import('node:stream').Readable} src
 * @param {import('node:stream').Writable} dest
 * @param {{ keepSrcConnected?: boolean }} [options]
 */
function safePipe(src, dest, options = {}) {
    const keepSrcConnected = options.keepSrcConnected === true;
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
            if (keepSrcConnected) {
                try {
                    dest.destroy();
                } catch {}
                return;
            }
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
    return createPacedDiscardSink('discard');
}

/**
 * Consume librespot PCM at real-time speed so tracks don't finish instantly.
 * @param {string} label
 */
function createPacedDiscardSink(label) {
    const bytesPerSecond = PCM_RATE * PCM_CHANNELS * 2;
    /** @type {Buffer[]} */
    const queue = [];
    let queuedBytes = 0;
    /** @type {(() => void) | null} */
    let pendingWriteCb = null;
    const maxQueuedBytes = bytesPerSecond * 3;
    const tickMs = 20;
    const bytesPerTick = Math.max(1, Math.floor((bytesPerSecond * tickMs) / 1000));

    const timer = setInterval(() => {
        let budget = bytesPerTick;
        while (budget > 0 && queue.length > 0) {
            const head = queue[0];
            if (head.length <= budget) {
                budget -= head.length;
                queuedBytes -= head.length;
                queue.shift();
            } else {
                queue[0] = head.subarray(budget);
                queuedBytes -= budget;
                budget = 0;
            }
        }

        if (pendingWriteCb && queuedBytes <= maxQueuedBytes * 0.75) {
            const cb = pendingWriteCb;
            pendingWriteCb = null;
            cb();
        }
    }, tickMs);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    const sink = new Writable({
        write(chunk, _enc, cb) {
            queue.push(chunk);
            queuedBytes += chunk.length;
            if (queuedBytes <= maxQueuedBytes) {
                cb();
                return;
            }
            pendingWriteCb = cb;
        },
        final(cb) {
            clearInterval(timer);
            queue.length = 0;
            queuedBytes = 0;
            cb();
        },
        destroy(err, cb) {
            clearInterval(timer);
            queue.length = 0;
            queuedBytes = 0;
            cb(err);
        },
    });
    guardStreamErrors(sink, label);
    return sink;
}

function cacheDir(guildId) {
    return audioCacheDir(guildId);
}

/**
 * @param {string} guildId
 */
function isLinked(guildId) {
    return (
        Boolean(getGuildSpotifyRow(guildId)) && hasLibrespotCredentials(guildId)
    );
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
function tearDownFfmpegPipe(rt) {
    if (rt.ffmpegPipeUnpipe) {
        try {
            rt.ffmpegPipeUnpipe();
        } catch {}
        rt.ffmpegPipeUnpipe = null;
    }
}

/**
 * @param {GuildSpotifyRuntime} rt
 */
function tearDownSinkPipe(rt) {
    if (rt.sinkPipeUnpipe) {
        try {
            rt.sinkPipeUnpipe();
        } catch {}
        rt.sinkPipeUnpipe = null;
    }
    try {
        rt.discard?.destroy();
    } catch {}
    rt.discard = null;
}

/**
 * @param {GuildSpotifyRuntime} rt
 */
function tearDownPipes(rt) {
    tearDownFfmpegPipe(rt);
    tearDownSinkPipe(rt);
    if (rt.librespotPipeUnpipe) {
        try {
            rt.librespotPipeUnpipe();
        } catch {}
        rt.librespotPipeUnpipe = null;
    }
    try {
        rt.librespot?.stdout?.unpipe();
    } catch {}
    try {
        rt.pcmBridge?.destroy();
    } catch {}
    rt.pcmBridge = null;
}

/**
 * Keep librespot stdout on a persistent bridge so ffmpeg restarts never EPIPE librespot.
 * @param {string} guildId
 * @param {GuildSpotifyRuntime} rt
 */
function wireLibrespotPcmBridge(guildId, rt) {
    if (rt.pcmBridge && rt.librespotPipeUnpipe) {
        return;
    }

    const bridge = new PassThrough({ highWaterMark: 1024 * 1024 });
    guardStreamErrors(bridge, `${guildId} pcm bridge`);
    rt.pcmBridge = bridge;
    rt.librespotPipeUnpipe = safePipe(rt.librespot.stdout, bridge, {
        keepSrcConnected: true,
    });
}

/**
 * @param {string} guildId
 * @param {GuildSpotifyRuntime} rt
 */
function startStandbySink(guildId, rt) {
    wireLibrespotPcmBridge(guildId, rt);
    tearDownSinkPipe(rt);
    rt.discard = createPacedDiscardSink(`${guildId} paced discard`);
    rt.sinkPipeUnpipe = safePipe(rt.pcmBridge, rt.discard);
}

/**
 * @param {string} guildId
 * @param {boolean} [unlink]
 */
async function stopGuild(guildId, unlink = false) {
    const { cancelPendingOAuth } = require('./spotifyLibrespotOAuth');
    cancelPendingOAuth(guildId);

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
        clearLibrespotCache(guildId);
    }
}

/**
 * @param {string} guildId
 * @param {string} accessToken
 * @param {string} deviceName
 */
function buildLibrespotArgs(guildId, deviceName) {
    const args = [
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
        '--system-cache',
        systemCacheDir(guildId),
        '--disable-discovery',
    ];

    if (hasLibrespotCredentials(guildId)) {
        return args;
    }

    throw new Error(
        'Spotify credentials missing. Run `/spotify unlink` then `/spotify link` to sign in again.'
    );
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

    wireLibrespotPcmBridge(guildId, rt);
    tearDownFfmpegPipe(rt);
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

    rt.ffmpegPipeUnpipe = safePipe(rt.pcmBridge, ffmpeg.stdin);

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
        tearDownFfmpegPipe(current);

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

    const startPlayback = () => {
        const current = runtimes.get(guildId);
        if (!current || current.ffmpeg !== ffmpeg) {
            return;
        }
        player.play(resource);
    };

    if (ffmpeg.stdout.readableLength > 0) {
        startPlayback();
        return;
    }

    const onReadable = () => {
        if (ffmpeg.stdout.readableLength > 0) {
            ffmpeg.stdout.off('readable', onReadable);
            startPlayback();
        }
    };
    ffmpeg.stdout.on('readable', onReadable);

    const startTimeout = setTimeout(() => {
        ffmpeg.stdout.off('readable', onReadable);
        startPlayback();
    }, 2_000);
    if (typeof startTimeout.unref === 'function') {
        startTimeout.unref();
    }
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
 * Rewire playback output without restarting librespot (avoids Spotify NEW_SESSION churn).
 * @param {string} guildId
 * @param {ConnectMode} mode
 * @param {import('@discordjs/voice').AudioPlayer} [player]
 */
async function switchConnectMode(guildId, mode, player) {
    const rt = runtimes.get(guildId);
    if (!rt || !isActive(guildId)) {
        await startSession(guildId, mode, player);
        return;
    }

    if (rt.mode === mode) {
        if (mode === 'discord' && player && !rt.ffmpeg) {
            rt.player = player;
            startDiscordFfmpeg(guildId, rt, player);
        }
        return;
    }

    wireLibrespotPcmBridge(guildId, rt);

    if (mode === 'discord') {
        if (!player) {
            throw new Error('Discord player is required for voice output.');
        }
        const { stopAndClear } = require('./youtubeQueue');
        stopAndClear(guildId);
        tearDownSinkPipe(rt);
        rt.player = player;
        rt.mode = 'discord';
        startDiscordFfmpeg(guildId, rt, player);
        console.log(
            `[spotify:${guildId}] switched Connect device to discord voice output`
        );
        return;
    }

    tearDownFfmpegPipe(rt);
    killChild(rt.ffmpeg);
    rt.ffmpeg = null;
    rt.player = null;
    rt.mode = 'standby';
    startStandbySink(guildId, rt);
    console.log(`[spotify:${guildId}] switched Connect device to standby`);
}

/**
 * @param {string} guildId
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
    if (existing && isActive(guildId)) {
        if (existing.mode !== mode) {
            await switchConnectMode(guildId, mode, player);
            return;
        }
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
    if (!hasLibrespotCredentials(guildId)) {
        throw new Error(
            'Spotify is linked in the database but credentials are missing. Run `/spotify link` again.'
        );
    }
    const deviceName = row?.device_name || defaultDeviceName();
    const args = buildLibrespotArgs(guildId, deviceName);

    const librespot = spawn(LIBRESPOT_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const rt = {
        librespot,
        ffmpeg: null,
        discard: null,
        pcmBridge: null,
        mode,
        player: player ?? null,
        tokenRefreshTimer: null,
        playerErrorHandler: null,
        playerStateHandler: null,
        librespotPipeUnpipe: null,
        sinkPipeUnpipe: null,
        ffmpegPipeUnpipe: null,
        restartingFfmpeg: false,
        lastLog: '',
        startedAt: Date.now(),
    };
    runtimes.set(guildId, rt);
    wireLibrespotLogs(guildId, librespot, rt);

    guardStreamErrors(librespot.stdout, `${guildId} librespot stdout`);

    if (mode === 'standby') {
        startStandbySink(guildId, rt);
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
                /INVALID_CREDENTIALS|Bad credentials|could not initialize spirc/i.test(
                    line
                )
            ) {
                clearLibrespotCache(guildId);
                finish(
                    new Error(
                        'Spotify login expired or was rejected. Run `/spotify unlink` then `/spotify link` again (Premium account required).'
                    )
                );
                return;
            }
            if (/Authenticated as/i.test(line) && isActive(guildId)) {
                setTimeout(() => {
                    if (settled || !isActive(guildId)) {
                        return;
                    }
                    finish();
                }, 3000);
            }
        };
        librespot.stderr.on('data', checkReady);
    });

    console.log(
        `[spotify:${guildId}] Connect device "${deviceName}" (${mode}) — should appear in the Spotify app`
    );

    rt.tokenRefreshTimer = setInterval(async () => {
        try {
            if (!isActive(guildId) || !hasLibrespotCredentials(guildId)) {
                return;
            }
            if (rt.lastLog && /INVALID_CREDENTIALS|Bad credentials/i.test(rt.lastLog)) {
                console.warn(`[spotify:${guildId}] credentials invalid; restart skipped`);
                return;
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
    if (isActive(guildId)) {
        await switchConnectMode(guildId, 'discord', player);
        return;
    }
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
        await switchConnectMode(guildId, 'standby');
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
