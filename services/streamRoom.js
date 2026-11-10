const SEEK_STEP_MS = 10_000;
const PREVIOUS_RESTART_MS = 3_000;
const SEEK_COALESCE_MS = 400;
const HISTORY_LIMIT = 50;
const VIEWER_STALE_MS = 12_000;

/**
 * @typedef {{
 *   videoId: string,
 *   url: string,
 *   title: string,
 *   durationMs: number | null,
 * }} StreamItem
 */

/**
 * @typedef {{
 *   items: StreamItem[],
 *   history: StreamItem[],
 *   status: 'idle' | 'playing' | 'paused' | 'stopped',
 *   positionMs: number,
 *   anchorAt: number,
 *   volume: number,
 *   revision: number,
 *   generation: number,
 * }} StreamRoom
 */

/** @type {Map<string, StreamRoom>} */
const rooms = new Map();

function fail(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function createRoom() {
    return {
        items: [],
        history: [],
        status: 'idle',
        positionMs: 0,
        anchorAt: 0,
        volume: 100,
        revision: 0,
        generation: 0,
    };
}

/**
 * @param {string} guildId
 * @returns {StreamRoom}
 */
function room(guildId) {
    let state = rooms.get(guildId);
    if (!state) {
        state = createRoom();
        rooms.set(guildId, state);
    }
    return state;
}

/**
 * @param {StreamRoom} state
 * @param {number} now
 */
function livePosition(state, now) {
    if (!state.items.length) {
        return 0;
    }
    if (state.status !== 'playing') {
        return Math.max(0, state.positionMs);
    }
    return Math.max(0, state.positionMs + (now - state.anchorAt));
}

/**
 * @param {StreamRoom} state
 */
function bump(state) {
    state.revision += 1;
}

/**
 * @param {StreamRoom} state
 * @param {StreamItem | undefined} item
 */
function remember(state, item) {
    if (!item) {
        return;
    }
    state.history.push(item);
    if (state.history.length > HISTORY_LIMIT) {
        state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
}

/**
 * Move to the next item. Playing continues when another item is queued.
 * @param {StreamRoom} state
 * @param {number} now
 */
function advance(state, now) {
    remember(state, state.items.shift());
    state.positionMs = 0;
    state.anchorAt = now;
    state.generation += 1;
    bump(state);
    if (!state.items.length) {
        state.status = 'idle';
    }
}

/**
 * @param {StreamRoom | undefined} state
 * @param {number} now
 * @returns {boolean} true when the current item ended and the room moved on
 */
function catchUp(state, now) {
    if (!state || state.status !== 'playing' || !state.items.length) {
        return false;
    }
    const duration = state.items[0].durationMs;
    if (!duration || duration <= 0) {
        return false;
    }
    if (livePosition(state, now) < duration) {
        return false;
    }
    advance(state, now);
    return true;
}

/**
 * @param {StreamItem} item
 */
function publicItem(item) {
    return {
        videoId: item.videoId,
        title: item.title || 'YouTube',
        url: item.url || '',
        durationMs: item.durationMs || null,
    };
}

/**
 * @param {string} guildId
 * @param {number} [now]
 */
function getStreamView(guildId, now = Date.now()) {
    const state = guildId ? rooms.get(guildId) : null;
    if (!state) {
        return {
            status: 'idle',
            positionMs: 0,
            durationMs: null,
            revision: 0,
            serverNow: now,
            current: null,
            upcoming: [],
            total: 0,
            volume: 100,
            canPrevious: false,
            viewers: [],
        };
    }
    catchUp(state, now);
    const current = state.items[0] || null;
    const positionMs = current ? Math.round(livePosition(state, now)) : 0;
    let status = state.status;
    if (!current) {
        status = 'idle';
    } else if (status === 'idle') {
        status = 'stopped';
    }
    return {
        status,
        positionMs,
        durationMs: current?.durationMs || null,
        revision: state.revision,
        serverNow: now,
        current: current ? publicItem(current) : null,
        upcoming: state.items.slice(1).map((item, index) => ({
            ...publicItem(item),
            index,
        })),
        total: state.items.length,
        volume: state.volume,
        canPrevious: Boolean(current) || state.history.length > 0,
        viewers: listViewers(state, now),
    };
}

/**
 * @param {StreamRoom} state
 * @param {number} now
 */
function listViewers(state, now) {
    if (!state.viewers) {
        return [];
    }
    const people = [];
    for (const [id, viewer] of state.viewers) {
        if (now - viewer.seenAt > VIEWER_STALE_MS) {
            state.viewers.delete(id);
            continue;
        }
        people.push({ id: viewer.id, username: viewer.username });
    }
    people.sort((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
    return people;
}

/**
 * @param {string} guildId
 * @param {{ id?: string, username?: string }} viewer
 * @param {number} [now]
 */
function touchViewer(guildId, viewer, now = Date.now()) {
    const id = String(viewer?.id || '').trim();
    if (!guildId || !id) {
        return getStreamView(guildId, now);
    }
    const state = room(guildId);
    if (!state.viewers) {
        state.viewers = new Map();
    }
    const username = String(viewer.username || id).trim().slice(0, 64) || id;
    state.viewers.set(id, { id, username, seenAt: now });
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {string} viewerId
 */
function leaveViewer(guildId, viewerId, now = Date.now()) {
    const state = rooms.get(guildId);
    const id = String(viewerId || '').trim();
    if (state?.viewers && id) {
        state.viewers.delete(id);
    }
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {StreamItem[]} items
 * @param {number} [now]
 */
function addItems(guildId, items, now = Date.now()) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        throw fail('No playable YouTube video found.');
    }
    const state = room(guildId);
    catchUp(state, now);
    const start = state.items.length === 0;
    for (const item of list) {
        if (!item?.videoId) {
            throw fail('No playable YouTube video found.');
        }
        state.items.push({
            videoId: item.videoId,
            url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
            title: item.title || 'YouTube',
            durationMs: item.durationMs || null,
        });
    }
    if (start) {
        state.status = 'playing';
        state.positionMs = 0;
        state.anchorAt = now;
        state.generation += 1;
        bump(state);
    }
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} [now]
 */
function play(guildId, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length) {
        throw fail('Nothing is queued.');
    }
    if (state.status === 'playing') {
        return getStreamView(guildId, now);
    }
    state.positionMs = Math.round(livePosition(state, now));
    state.anchorAt = now;
    state.status = 'playing';
    bump(state);
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} [now]
 */
function pause(guildId, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length) {
        throw fail('Nothing is playing or queued.');
    }
    if (state.status === 'paused') {
        return getStreamView(guildId, now);
    }
    if (state.status !== 'playing') {
        throw fail('Nothing is playing.');
    }
    state.positionMs = Math.round(livePosition(state, now));
    state.anchorAt = now;
    state.status = 'paused';
    bump(state);
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} [now]
 */
function stop(guildId, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length) {
        throw fail('Nothing is playing or queued.');
    }
    state.status = 'stopped';
    state.positionMs = 0;
    state.anchorAt = now;
    bump(state);
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} positionMs
 * @param {number} [now]
 */
function seek(guildId, positionMs, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length) {
        throw fail('Nothing is playing or queued.');
    }
    const duration = state.items[0].durationMs;
    const target = Math.max(0, Math.round(Number(positionMs) || 0));
    if (duration && target >= duration - SEEK_COALESCE_MS) {
        advance(state, now);
        if (state.items.length) {
            state.status = 'playing';
            state.anchorAt = now;
            state.positionMs = 0;
        }
        return getStreamView(guildId, now);
    }
    const here = livePosition(state, now);
    if (Math.abs(target - here) < SEEK_COALESCE_MS) {
        return getStreamView(guildId, now);
    }
    state.positionMs = duration ? Math.min(target, duration) : target;
    state.anchorAt = now;
    bump(state);
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} deltaMs
 * @param {number} [now]
 */
function seekBy(guildId, deltaMs, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length) {
        throw fail('Nothing is playing or queued.');
    }
    return seek(guildId, livePosition(state, now) + deltaMs, now);
}

/**
 * @param {string} guildId
 * @param {number} [now]
 */
function skip(guildId, now = Date.now()) {
    const state = room(guildId);
    if (!state.items.length) {
        throw fail('Nothing is playing or queued.');
    }
    const before = state.items[0].videoId;
    const advanced = catchUp(state, now);
    if (!state.items.length) {
        return getStreamView(guildId, now);
    }
    if (!(advanced && state.items[0].videoId !== before)) {
        advance(state, now);
    }
    if (state.items.length) {
        state.status = 'playing';
        state.positionMs = 0;
        state.anchorAt = now;
    }
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} [now]
 * @returns {string}
 */
function previous(guildId, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (!state.items.length && !state.history.length) {
        throw fail('Nothing is queued.');
    }
    const position = state.items.length
        ? livePosition(state, now)
        : PREVIOUS_RESTART_MS + 1;
    if (state.items.length && position > PREVIOUS_RESTART_MS) {
        state.positionMs = 0;
        state.anchorAt = now;
        bump(state);
        return 'Back to the start.';
    }
    const prev = state.history.pop();
    if (!prev) {
        state.positionMs = 0;
        state.anchorAt = now;
        bump(state);
        return 'Back to the start.';
    }
    state.items.unshift(prev);
    state.positionMs = 0;
    state.anchorAt = now;
    state.generation += 1;
    bump(state);
    if (state.status === 'idle') {
        state.status = 'playing';
    }
    return 'Previous.';
}

/**
 * @param {string} guildId
 * @param {number} index upcoming index, matching the queue tab
 * @param {number} [now]
 */
function removeUpcoming(guildId, index, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (state.items.length < 2) {
        throw fail('Nothing else is queued.');
    }
    const at = Number(index) + 1;
    if (!Number.isInteger(at) || at < 1 || at >= state.items.length) {
        throw fail('That queued video is not there.');
    }
    state.items.splice(at, 1);
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} fromIndex
 * @param {number} toIndex
 * @param {number} [now]
 */
function moveItem(guildId, fromIndex, toIndex, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    if (state.items.length < 2) {
        throw fail('Add another video before changing the order.');
    }
    const from = Number(fromIndex);
    const to = Number(toIndex);
    const count = state.items.length;
    if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to < 0 ||
        from >= count ||
        to >= count
    ) {
        throw fail('That video is not in the queue.');
    }
    if (from === to) {
        return getStreamView(guildId, now);
    }
    const [item] = state.items.splice(from, 1);
    state.items.splice(to, 0, item);
    if (from === 0 || to === 0) {
        state.positionMs = 0;
        state.anchorAt = now;
        state.generation += 1;
        bump(state);
    }
    return getStreamView(guildId, now);
}

/**
 * @param {string} guildId
 * @param {number} percent
 */
function setVolume(guildId, percent) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || percent % 5 !== 0) {
        throw fail('Volume must be in steps of 5 (0, 5, 10, … 100).');
    }
    const state = room(guildId);
    state.volume = percent;
    return getStreamView(guildId);
}

/**
 * Backup advance for a video with no known duration.
 * Ignored when that video is no longer current, so several tabs cannot skip twice.
 * @param {string} guildId
 * @param {string} videoId
 * @param {number} [now]
 */
function reportEnded(guildId, videoId, now = Date.now()) {
    const state = room(guildId);
    catchUp(state, now);
    const current = state.items[0];
    if (!current || current.videoId !== videoId) {
        return getStreamView(guildId, now);
    }
    if (current.durationMs || state.status !== 'playing') {
        return getStreamView(guildId, now);
    }
    advance(state, now);
    return getStreamView(guildId, now);
}

module.exports = {
    addItems,
    play,
    pause,
    stop,
    previous,
    skip,
    seek,
    seekBy,
    removeUpcoming,
    moveItem,
    setVolume,
    reportEnded,
    getStreamView,
    touchViewer,
    leaveViewer,
    SEEK_STEP_MS,
    PREVIOUS_RESTART_MS,
    VIEWER_STALE_MS,
};
