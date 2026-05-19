const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const ffmpegStatic = require('ffmpeg-static');
const {
    getValidAccessToken,
    getGuildSpotifyRow,
    defaultDeviceName,
} = require('./spotifyAuth');

const LIBRESPOT_BIN = process.env.LIBRESPOT_PATH || 'librespot';
const PCM_RATE = Number(process.env.SPOTIFY_PCM_RATE) || 44100;
const PCM_CHANNELS = 2;

/**
 * @typedef {{
 *   librespot: import('node:child_process').ChildProcess,
 *   ffmpeg: import('node:child_process').ChildProcess,
 *   tokenRefreshTimer: NodeJS.Timeout | null,
 * }} GuildSpotifyRuntime
 */

/** @type {Map<string, GuildSpotifyRuntime>} */
const runtimes = new Map();

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

function killChild(child) {
    if (!child || child.killed) {
        return;
    }
    try {
        child.kill('SIGKILL');
    } catch {}
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
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
async function startDiscordOutput(guildId, player) {
    if (!isLinked(guildId)) {
        return;
    }

    if (isActive(guildId)) {
        return;
    }

    if (!ffmpegStatic) {
        throw new Error('ffmpeg-static is missing; cannot pipe Spotify audio to Discord.');
    }

    const row = getGuildSpotifyRow(guildId);
    const accessToken = await getValidAccessToken(guildId);
    const deviceName = row?.device_name || defaultDeviceName();

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
        '--token',
        accessToken,
    ];

    const librespot = spawn(LIBRESPOT_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

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

    librespot.stdout.pipe(ffmpeg.stdin);

    const rt = {
        librespot,
        ffmpeg,
        tokenRefreshTimer: null,
    };
    runtimes.set(guildId, rt);

    librespot.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
            console.log(`[spotify:${guildId}]`, line.slice(0, 500));
        }
    });

    ffmpeg.stderr.on('data', (chunk) => {
        const t = chunk.toString().trim();
        if (t) {
            console.warn(`[spotify:${guildId}] ffmpeg:`, t.slice(0, 300));
        }
    });

    librespot.on('error', (err) => {
        if (err.code === 'ENOENT') {
            console.error(
                '[spotify] librespot not found. Install librespot and set LIBRESPOT_PATH if needed.'
            );
        } else {
            console.error(`[spotify:${guildId}] librespot error:`, err);
        }
    });

    ffmpeg.on('error', (err) => {
        console.error(`[spotify:${guildId}] ffmpeg error:`, err);
    });

    const onDead = () => {
        const current = runtimes.get(guildId);
        if (current && (current.librespot === librespot || current.ffmpeg === ffmpeg)) {
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

    ffmpeg.on('close', (code) => {
        console.log(`[spotify:${guildId}] ffmpeg exited`, code);
        killChild(librespot);
        onDead();
    });

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
    });

    player.play(resource);
    console.log(
        `[spotify:${guildId}] Connect device "${deviceName}" active — pick it in the Spotify app`
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
            const { getConnectionData } = require('./voiceManager');
            const data = getConnectionData(guildId);
            if (!data?.player) {
                return;
            }
            console.log(`[spotify:${guildId}] restarting session after token refresh`);
            await stopGuild(guildId, false);
            await startDiscordOutput(guildId, data.player);
        } catch (e) {
            console.error(`[spotify:${guildId}] token refresh:`, e);
        }
    }, 5 * 60 * 1000);
    if (typeof rt.tokenRefreshTimer.unref === 'function') {
        rt.tokenRefreshTimer.unref();
    }
}

/**
 * @param {string} guildId
 */
function stopDiscordOutput(guildId) {
    if (isActive(guildId)) {
        stopGuild(guildId, false);
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
    startDiscordOutput,
    stopDiscordOutput,
    attachIfLinkedInVoice,
    stopGuild,
    isLinked,
    isActive,
};
