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
 * @typedef {{ url: string, title: string | null, intro?: boolean, introUser?: string }} QueueItem
 * @typedef {{
 *   items: QueueItem[],
 *   player: import('@discordjs/voice').AudioPlayer,
 *   textChannel: import('discord.js').TextBasedChannel | null,
 *   generation: number,
 *   drainChain: Promise<void>,
 *   onPlayerError: (err: Error) => void,
 *   ytdlpChild: import('node:child_process').ChildProcess | null,
 *   volumePercent: number,
 * }} GuildQueueState
 */

const MAX_PLAYLIST_TRACKS = 25;
const IDLE_WAIT_MS = 3_600_000;
const MAX_YTDLP_STDERR_BYTES = 128 * 1024;

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
            extraArgs: [
                '--extractor-args',
                process.env.YT_DLP_EXTRACTOR_ARGS.trim(),
            ],
        });
    }

    const cookieFile = process.env.YT_DLP_COOKIES?.trim();
    if (cookieFile) {
        profiles.push({
            name: 'cookies-file',
            format: defaultFormat,
            extraArgs: [
                '--cookies',
                cookieFile,
                '--extractor-args',
                'youtube:player_client=default,-android_sdkless',
                '--js-runtimes',
                'node',
            ],
        });
    }

    const cookieBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim();
    if (cookieBrowser) {
        profiles.push({
            name: `cookies-${cookieBrowser}`,
            format: defaultFormat,
            extraArgs: [
                '--cookies-from-browser',
                cookieBrowser,
                '--extractor-args',
                'youtube:player_client=default,-android_sdkless',
                '--js-runtimes',
                'node',
            ],
        });
    }

    profiles.push({
        name: 'default',
        format: defaultFormat,
        extraArgs: [
            '--extractor-args',
            'youtube:player_client=default,-android_sdkless',
            '--js-runtimes',
            'node',
        ],
    });

    profiles.push({
        name: 'm3u8-ios',
        format: 'ba[protocol=m3u8_native]/bestaudio[ext=m4a]/bestaudio/best',
        extraArgs: [
            '--extractor-args',
            'youtube:player_client=default,ios,-android_sdkless;formats=missing_pot',
            '--js-runtimes',
            'node',
        ],
    });

    return profiles;
}

/**
 * @param {string} url
 * @param {YtdlpProfile} profile
 */
function buildYtdlpArgs(url, profile) {
    return [
        '-f',
        profile.format,
        '-S',
        '+abr',
        '-o',
        '-',
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        ...profile.extraArgs,
        url,
    ];
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
function streamYoutubeViaYtdlp(url, profile) {
    const bin = process.env.YT_DLP_PATH || 'yt-dlp';
    const args = buildYtdlpArgs(url, profile);

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
 * @returns {Promise<{ stream: import('node:stream').Readable, child?: import('node:child_process').ChildProcess, playDl?: Awaited<ReturnType<typeof createYoutubeStream>> }>}
 */
async function streamYoutubeWithFallbacks(url) {
    for (const profile of getYtdlpProfiles()) {
        try {
            const result = await streamYoutubeViaYtdlp(url, profile);
            console.log(`[YouTube queue] streaming via yt-dlp (${profile.name})`);
            return result;
        } catch (err) {
            console.warn(
                `[YouTube queue] yt-dlp (${profile.name}) failed:`,
                err.message || err
            );
        }
    }

    console.warn('[YouTube queue] yt-dlp exhausted, trying play-dl');
    const play = getPlayDl();
    const ytStream = await createYoutubeStream(play, url);
    return { stream: ytStream.stream, playDl: ytStream };
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

        const streamed = await streamYoutubeWithFallbacks(item.url);
        if (streamed.child) {
            state.ytdlpChild = streamed.child;
            streamed.child.on('close', () => {
                if (state.ytdlpChild === streamed.child) {
                    state.ytdlpChild = null;
                }
            });
            resource = createAudioResource(streamed.stream, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
                metadata: { title: item.title, url: item.url },
            });
        } else if (streamed.playDl) {
            resource = createAudioResource(streamed.stream, {
                inputType: streamed.playDl.type,
                inlineVolume: true,
                metadata: { title: item.title, url: item.url },
            });
            try {
                getPlayDl().attachListeners(state.player, streamed.playDl);
            } catch {}
            console.log('[YouTube queue] streaming via play-dl');
        } else {
            throw new Error('No YouTube stream source available.');
        }

        applyVolumeToResource(resource, state.volumePercent);

        state.player.play(resource);

        if (state.textChannel) {
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
                    `Could not play **${item.title}**: ${err.message || err}\n` +
                        'If this is a YouTube 403 error, update yt-dlp (`yt-dlp -U`) and restart the bot. See `docs/youtube-playback.md`.'
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
    killYtdlpChild(state);
    try {
        state.player.stop(true);
    } catch {}
    state.items.shift();
    chainDrain(state, () => playNextFromQueue(state));
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
    isPlayDlInstalled,
    setYoutubeVolume,
    getYoutubeVolume,
};
