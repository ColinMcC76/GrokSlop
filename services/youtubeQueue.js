const { spawn } = require('node:child_process');
const {
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
} = require('@discordjs/voice');

/** @type {Map<string, GuildQueueState>} */
const queues = new Map();

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
 * @typedef {{ url: string, title: string | null }} QueueItem
 * @typedef {{
 *   items: QueueItem[],
 *   player: import('@discordjs/voice').AudioPlayer,
 *   textChannel: import('discord.js').TextBasedChannel | null,
 *   generation: number,
 *   drainChain: Promise<void>,
 *   onPlayerError: (err: Error) => void,
 * }} GuildQueueState
 */

const MAX_PLAYLIST_TRACKS = 25;
const IDLE_WAIT_MS = 3_600_000;

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
    const attempts = [
        async () =>
            play.stream_from_info(await play.video_info(url), {
                discordPlayerCompatibility: true,
            }),
        async () => play.stream(url, { discordPlayerCompatibility: true }),
        async () =>
            play.stream_from_info(await play.video_info(url), {
                discordPlayerCompatibility: false,
            }),
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
 * YouTube breaks unofficial parsers often; yt-dlp is the reliable path (install separately).
 * @returns {Promise<{ stream: import('node:stream').Readable, child: import('node:child_process').ChildProcess }>}
 */
function streamYoutubeViaYtdlp(url) {
    const bin = process.env.YT_DLP_PATH || 'yt-dlp';
    // Prefer higher-bitrate audio-only; override with YT_DLP_FORMAT if needed.
    const format =
        process.env.YT_DLP_FORMAT ||
        'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best/ba/b';
    const args = [
        '-f',
        format,
        '-S',
        '-abr,-asr',
        '-o',
        '-',
        '--no-playlist',
        '--quiet',
        '--no-progress',
        '--no-warnings',
        url,
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const stderrChunks = [];
        child.stderr.on('data', (chunk) => {
            stderrChunks.push(chunk);
        });

        const hangMs = 25_000;
        let hangTimer;
        let streamGiven = false;

        child.on('error', (err) => {
            if (streamGiven) {
                console.error('[YouTube queue] yt-dlp error after stream start:', err);
                return;
            }
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
            if (err.code === 'ENOENT') {
                err.message =
                    'yt-dlp is not installed or not on PATH. Install: https://github.com/yt-dlp/yt-dlp#installation — or set YT_DLP_PATH to the executable.';
            }
            try {
                child.kill('SIGKILL');
            } catch {}
            reject(err);
        });

        child.on('close', (code, signal) => {
            const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
            if (code !== 0 && code !== null) {
                console.error(
                    '[YouTube queue] yt-dlp exited',
                    code,
                    signal || '',
                    errText ? errText.slice(0, 600) : ''
                );
            }
        });

        // Resolve immediately. Do NOT use stdout.once('data') before piping — in flowing mode that
        // consumes the first chunk, so FFmpeg never sees the container header and playback is silent.
        streamGiven = true;
        resolve({ stream: child.stdout, child });

        hangTimer = setTimeout(() => {
            const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
            try {
                child.kill('SIGKILL');
            } catch {}
            console.error(
                '[YouTube queue] yt-dlp hang:',
                `no stdout activity for ${hangMs / 1000}s`,
                errText ? errText.slice(0, 400) : ''
            );
        }, hangMs);
        if (typeof hangTimer.unref === 'function') {
            hangTimer.unref();
        }

        child.stdout.once('readable', () => {
            if (hangTimer) {
                clearTimeout(hangTimer);
            }
        });
    });
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
        };
        queues.set(guildId, s);
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
        return [{ url: normalized, title }];
    }

    if (v === 'yt_playlist') {
        const pl = await play.playlist_info(normalized, { incomplete: true });
        await pl.fetch();
        const videos = await pl.all_videos();
        return videos.slice(0, MAX_PLAYLIST_TRACKS).map((vid) => ({
            url: vid.url,
            title: vid.title || 'YouTube',
        }));
    }

    const results = await play.search(normalized, {
        limit: 1,
        source: { youtube: 'video' },
    });
    if (!results.length) {
        throw new Error('No YouTube results found.');
    }
    const first = results[0];
    return [{ url: first.url, title: first.title || q }];
}

async function playCurrentTrack(state) {
    const item = state.items[0];
    if (!item) {
        return;
    }

    const gen = state.generation;
    killYtdlpChild(state);

    try {
        let resource;

        try {
            const { stream, child } = await streamYoutubeViaYtdlp(item.url);
            state.ytdlpChild = child;
            child.on('close', () => {
                if (state.ytdlpChild === child) {
                    state.ytdlpChild = null;
                }
            });
            resource = createAudioResource(stream, {
                inputType: StreamType.Arbitrary,
                metadata: { title: item.title, url: item.url },
            });
            console.log('[YouTube queue] streaming via yt-dlp');
        } catch (ytdlpErr) {
            console.warn('[YouTube queue] yt-dlp failed, trying play-dl:', ytdlpErr.message || ytdlpErr);
            const play = getPlayDl();
            const ytStream = await createYoutubeStream(play, item.url);
            resource = createAudioResource(ytStream.stream, {
                inputType: ytStream.type,
                metadata: { title: item.title, url: item.url },
            });
            try {
                play.attachListeners(state.player, ytStream);
            } catch {}
        }

        state.player.play(resource);

        if (state.textChannel) {
            try {
                await state.textChannel.send(
                    `Now playing: **${item.title}**\n${item.url}`
                );
            } catch {}
        }

        await waitUntilIdle(state.player, gen, state);

        if (state.generation !== gen) {
            return;
        }

        killYtdlpChild(state);
        state.items.shift();
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
                    `Could not play **${item.title}**: ${err.message || err}`
                );
            } catch {}
        }
        state.items.shift();
        await playNextFromQueue(state);
    }
}

async function playNextFromQueue(state) {
    if (state.items.length === 0) {
        return;
    }
    await playCurrentTrack(state);
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
        state.drainChain = state.drainChain.then(() => playCurrentTrack(state));
    }

    return { added: items.length, titles: items.map((i) => i.title) };
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
    state.drainChain = state.drainChain.then(() => playCurrentTrack(state));
}

function skip(guildId) {
    const state = queues.get(guildId);
    if (!state || state.items.length === 0) {
        return false;
    }
    state.generation += 1;
    killYtdlpChild(state);
    try {
        state.player.stop(true);
    } catch {}
    state.items.shift();
    state.drainChain = state.drainChain.then(() => playNextFromQueue(state));
    return true;
}

function stopAndClear(guildId) {
    const state = queues.get(guildId);
    if (!state) {
        return false;
    }
    state.generation += 1;
    killYtdlpChild(state);
    state.items.length = 0;
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
    killYtdlpChild(state);
    state.items.length = 0;
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

module.exports = {
    enqueue,
    skip,
    stopAndClear,
    removeGuild,
    queueLength,
    ensurePlaying,
    isPlayDlInstalled,
};
