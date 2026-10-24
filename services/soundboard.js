const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../storage/db');

const DIR = path.join(__dirname, '..', 'data', 'soundboard');
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_NAME = 48;
const PLAY_TIMEOUT_MS = 3 * 60 * 1000;

const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.webm', '.m4a', '.flac', '.aac']);

const selectAll = db.prepare(`
    SELECT id, name, ext, bytes, created_at, updated_at
    FROM soundbites
    ORDER BY name COLLATE NOCASE ASC
`);
const selectById = db.prepare(`
    SELECT id, name, ext, bytes, created_at, updated_at
    FROM soundbites
    WHERE id = ?
`);
const selectByName = db.prepare(`
    SELECT id FROM soundbites WHERE name = ? COLLATE NOCASE
`);
const insertBite = db.prepare(`
    INSERT INTO soundbites (id, name, ext, bytes, created_at, updated_at)
    VALUES (@id, @name, @ext, @bytes, @now, @now)
`);
const updateBite = db.prepare(`
    UPDATE soundbites
    SET name = @name, ext = @ext, bytes = @bytes, updated_at = @now
    WHERE id = @id
`);
const deleteBite = db.prepare(`DELETE FROM soundbites WHERE id = ?`);

let playback = Promise.resolve();
let playbackDepth = 0;
let stopRequested = false;
/** @type {{ stop: () => void } | null} */
let activePlayback = null;
/** @type {{ id: string, name: string, token: symbol } | null} */
let nowPlaying = null;

function fail(message, statusCode = 400) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function ensureDir() {
    fs.mkdirSync(DIR, { recursive: true });
}

function normalizeName(raw) {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_NAME) {
        throw fail(`Name must be 1–${MAX_NAME} characters.`);
    }
    return name;
}

function extensionFrom(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
        throw fail('Use an mp3, wav, ogg, webm, m4a, flac, or aac file.');
    }
    return ext === '.oga' ? '.ogg' : ext;
}

function filePathFor(id, ext) {
    return path.join(DIR, `${id}${ext}`);
}

function rowToPublic(row) {
    return {
        id: row.id,
        name: row.name,
        ext: row.ext,
        bytes: row.bytes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function assertUniqueName(name, exceptId) {
    const existing = selectByName.get(name);
    if (existing && existing.id !== exceptId) {
        throw fail(`A soundbite named “${name}” already exists.`, 409);
    }
}

function writeAudioFile(id, ext, buffer) {
    if (!buffer || buffer.length === 0) {
        throw fail('That file is empty.');
    }
    if (buffer.length > MAX_BYTES) {
        throw fail('That file is too large (max 12 MB).', 413);
    }
    ensureDir();
    const dest = filePathFor(id, ext);
    const tmp = path.join(DIR, `${id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, dest);
    return dest;
}

function removeFile(id, ext) {
    try {
        fs.unlinkSync(filePathFor(id, ext));
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            console.warn('[soundboard] could not delete file:', err.message || err);
        }
    }
}

function listSoundbites() {
    return selectAll.all().map(rowToPublic);
}

function getSoundbitePlayback() {
    if (!nowPlaying) {
        return null;
    }
    return { id: nowPlaying.id, name: nowPlaying.name };
}

function stopSoundbite() {
    if (playbackDepth === 0) {
        throw fail('Nothing is playing.');
    }
    stopRequested = true;
    try {
        activePlayback?.stop();
    } catch {
        /* the player may already be gone */
    }
    return 'Stopped.';
}

function getSoundbite(id) {
    const row = selectById.get(id);
    if (!row) {
        throw fail('That soundbite is gone.', 404);
    }
    return row;
}

function createSoundbite(nameRaw, filename, buffer) {
    const name = normalizeName(nameRaw);
    const ext = extensionFrom(filename);
    assertUniqueName(name);
    const id = crypto.randomUUID();
    const now = Date.now();
    writeAudioFile(id, ext, buffer);
    try {
        insertBite.run({ id, name, ext, bytes: buffer.length, now });
    } catch (err) {
        removeFile(id, ext);
        if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
            throw fail(`A soundbite named “${name}” already exists.`, 409);
        }
        throw err;
    }
    return rowToPublic(selectById.get(id));
}

function updateSoundbite(id, { name: nameRaw, filename, buffer }) {
    const row = getSoundbite(id);
    const name = nameRaw == null || nameRaw === '' ? row.name : normalizeName(nameRaw);
    assertUniqueName(name, id);
    let ext = row.ext;
    let bytes = row.bytes;
    if (buffer) {
        ext = extensionFrom(filename || `clip${row.ext}`);
        writeAudioFile(id, ext, buffer);
        bytes = buffer.length;
        if (ext !== row.ext) {
            removeFile(id, row.ext);
        }
    }
    updateBite.run({ id, name, ext, bytes, now: Date.now() });
    return rowToPublic(selectById.get(id));
}

function deleteSoundbite(id) {
    const row = getSoundbite(id);
    deleteBite.run(id);
    removeFile(id, row.ext);
    return { ok: true };
}

function voiceFailure(err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return fail(
            'Timed out connecting to voice. Check bot Connect and Speak permissions and try again.'
        );
    }
    return fail(err?.message || String(err));
}

/**
 * @param {import('@discordjs/voice').AudioPlayer} player
 * @param {string} filePath
 * @param {number} volumePercent
 */
function playFileOnPlayer(player, filePath, volumePercent) {
    const {
        AudioPlayerStatus,
        StreamType,
        createAudioResource,
        entersState,
    } = require('@discordjs/voice');
    const ffmpegStatic = require('ffmpeg-static');
    if (!ffmpegStatic) {
        return Promise.reject(fail('ffmpeg is not available, so this clip cannot be played.'));
    }

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(
            ffmpegStatic,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-i',
                filePath,
                '-f',
                's16le',
                '-ar',
                '48000',
                '-ac',
                '2',
                'pipe:1',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let stderr = '';
        let settled = false;
        let stopped = false;
        ffmpeg.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-500);
        });

        const resource = createAudioResource(ffmpeg.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true,
        });
        if (resource.volume) {
            const linear = Math.max(0, Math.min(1, volumePercent / 100));
            resource.volume.setVolume(linear);
        }

        const finish = (err) => {
            if (settled) return;
            settled = true;
            if (activePlayback?.stop === stop) {
                activePlayback = null;
            }
            try {
                ffmpeg.kill('SIGKILL');
            } catch {
                /* already exited */
            }
            if (stopped) {
                resolve(true);
                return;
            }
            if (err) reject(err);
            else resolve(false);
        };

        const stop = () => {
            stopped = true;
            try {
                player.stop(true);
            } catch {
                /* player may already be idle */
            }
            finish();
        };

        ffmpeg.on('error', (err) => finish(fail(err.message || String(err))));
        ffmpeg.on('close', (code) => {
            if (code && code !== 0 && !settled && stderr) {
                finish(fail(`Could not read that audio file. ${stderr.trim()}`));
            }
        });

        activePlayback = { stop };
        if (stopRequested) {
            stop();
            return;
        }

        player.play(resource);
        entersState(player, AudioPlayerStatus.Playing, 10_000)
            .then(() => entersState(player, AudioPlayerStatus.Idle, PLAY_TIMEOUT_MS))
            .then(() => finish())
            .catch((err) => finish(stopped ? null : voiceFailure(err)));
    });
}

/**
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string, voiceChannelId?: string, id: string }} opts
 */
async function playSoundbite(client, opts) {
    const { joinChannel, getConnectionData } = require('./voiceManager');
    const {
        getYoutubeVolume,
        suspendForExternalAudio,
        resumeAfterExternalAudio,
    } = require('./youtubeQueue');
    const { isRealtimeActive } = require('./realtimeVoiceBridge');
    const { isActive: isSpotifyActive } = require('./spotifyConnect');

    if (!client || typeof client.isReady !== 'function' || !client.isReady()) {
        throw fail('GrokSlop is not online yet.', 503);
    }
    const guildId = String(opts.guildId || '').trim();
    if (!guildId) {
        throw fail('Pick a server.');
    }
    const guild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
        throw fail('That server is not available.');
    }
    if (isRealtimeActive(guildId)) {
        throw fail('Turn off realtime voice before playing a soundbite.');
    }
    if (isSpotifyActive(guildId)) {
        throw fail('Spotify Connect is using the voice speaker. Unlink it or stop it first.');
    }

    const row = getSoundbite(opts.id);
    const absolute = filePathFor(row.id, row.ext);
    if (!fs.existsSync(absolute)) {
        throw fail('The audio file for that soundbite is missing.', 404);
    }

    const run = playback.catch(() => {}).then(async () => {
        playbackDepth += 1;
        const token = Symbol('soundbite');
        nowPlaying = { id: row.id, name: row.name, token };
        let resume = false;
        try {
            if (stopRequested) {
                return 'Stopped.';
            }
            let connection = getConnectionData(guildId);
            if (!connection) {
                const voiceChannelId = String(opts.voiceChannelId || '').trim();
                if (!voiceChannelId) {
                    throw fail('Join a voice channel first, or pick one on this page.');
                }
                const channel =
                    guild.channels.cache.get(voiceChannelId) ||
                    (await guild.channels.fetch(voiceChannelId).catch(() => null));
                if (!channel || !channel.isVoiceBased()) {
                    throw fail('Pick a voice channel.');
                }
                try {
                    connection = await joinChannel(channel);
                } catch (err) {
                    throw voiceFailure(err);
                }
            }
            if (stopRequested) {
                return 'Stopped.';
            }

            resume = await suspendForExternalAudio(guildId);
            if (stopRequested) {
                return 'Stopped.';
            }
            const stopped = await playFileOnPlayer(
                connection.player,
                absolute,
                getYoutubeVolume(guildId)
            );
            if (stopped) {
                return `Stopped “${row.name}”.`;
            }
            return `Played “${row.name}”.`;
        } finally {
            playbackDepth -= 1;
            stopRequested = false;
            if (nowPlaying?.token === token) {
                nowPlaying = null;
            }
            if (resume) {
                try {
                    resumeAfterExternalAudio(guildId);
                } catch (err) {
                    console.warn('[soundboard] could not resume music:', err?.message || err);
                }
            }
        }
    });
    playback = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

module.exports = {
    listSoundbites,
    getSoundbitePlayback,
    stopSoundbite,
    createSoundbite,
    updateSoundbite,
    deleteSoundbite,
    playSoundbite,
    MAX_BYTES,
    MAX_NAME,
};
