const {
    createAudioResource,
    AudioPlayerStatus,
} = require('@discordjs/voice');
const play = require('play-dl');

/** @type {Map<string, GuildQueueState>} */
const queues = new Map();

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
    const q = query.trim();
    if (!q) {
        throw new Error('Empty query.');
    }

    const validated = await play.validate(q).catch(() => false);
    const v = typeof validated === 'string' ? validated : '';

    if (v === 'yt_video') {
        const info = await play.video_basic_info(q);
        const title = info.video_details?.title || 'YouTube';
        return [{ url: q, title }];
    }

    if (v === 'yt_playlist') {
        const pl = await play.playlist_info(q, { incomplete: true });
        await pl.fetch();
        const videos = await pl.all_videos();
        return videos.slice(0, MAX_PLAYLIST_TRACKS).map((vid) => ({
            url: vid.url,
            title: vid.title || 'YouTube',
        }));
    }

    const results = await play.search(q, {
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

    try {
        const ytStream = await play.stream(item.url, {
            discordPlayerCompatibility: true,
        });

        const resource = createAudioResource(ytStream.stream, {
            inputType: ytStream.type,
            metadata: { title: item.title, url: item.url },
        });

        try {
            play.attachListeners(state.player, ytStream);
        } catch {}

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

        state.items.shift();
        await playNextFromQueue(state);
    } catch (err) {
        if (state.generation !== gen) {
            return;
        }
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
};
