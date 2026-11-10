const $ = (id) => document.getElementById(id);

const guildSelect = $('guild');
const resultEl = $('result');
const situationEl = $('situation');
const presenceEl = $('presence');
const taglineEl = $('tagline');
const nowTitle = $('nowTitle');
const playStateEl = $('playState');
const clockEl = $('clock');
const scrub = $('scrub');
const toggleBtn = $('toggle');
const stopBtn = $('stop');
const volumeInput = $('volume');
const queueList = $('queueList');
const joinBtn = $('join');

const DRIFT_MS = 350;
const SEEK_SETTLE_MS = 1500;

let latest = null;
let view = emptyView();
let scrubbing = false;
let voluming = false;
let dragging = false;
let pointerDrag = null;
let busy = false;
let seekHold = null;
let joined = false;
let player = null;
let playerReady = false;
let appliedVideoId = null;
let appliedRevision = -1;
let settleUntil = 0;
let appliedVolume = null;
let endedFor = '';

function emptyView() {
    return {
        status: 'idle',
        positionMs: 0,
        durationMs: null,
        revision: 0,
        serverNow: Date.now(),
        current: null,
        upcoming: [],
        total: 0,
        volume: 100,
        canPrevious: false,
    };
}

function setResult(text, kind) {
    resultEl.textContent = text;
    resultEl.className = `result ${kind || ''}`.trim();
}

function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        ms = 0;
    }
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
    }
    return `${String(minutes).padStart(2, '0')}:${seconds}`;
}

function statusLabel(status) {
    if (status === 'playing') return 'Playing';
    if (status === 'paused') return 'Paused';
    return 'Stopped';
}

function selectedGuild() {
    if (!latest) return null;
    return latest.guilds.find((guild) => guild.id === guildSelect.value) || null;
}

function paintSelectors() {
    const saved = readSelection();
    const guilds = latest?.guilds || [];
    fillSelect(
        guildSelect,
        guilds,
        guilds.length ? 'Select server' : 'No servers',
        (guild) => guild.name,
        saved.guildId
    );
    if (!guildSelect.value && guilds.length === 1) {
        guildSelect.value = guilds[0].id;
    }
}

function paintPresence() {
    if (!latest?.ready) {
        presenceEl.textContent = 'Offline';
        presenceEl.className = 'presence offline';
        taglineEl.textContent = latest?.botName ? `${latest.botName} · stream` : 'Stream';
        situationEl.textContent = 'Not online yet. The stream will show once Discord connects.';
        return;
    }
    presenceEl.textContent = 'Online';
    presenceEl.className = 'presence online';
    const ping = typeof latest.ping === 'number' && latest.ping >= 0 ? `${latest.ping}ms` : 'ping —';
    taglineEl.textContent = `${latest.tag || latest.botName} · ${ping}`;
    const guild = selectedGuild();
    situationEl.textContent = guild
        ? `Shared stream for ${guild.name}. Everyone here watches the same picture.`
        : 'Pick a server.';
}

function expectedPosition() {
    if (view.status !== 'playing') {
        return view.positionMs || 0;
    }
    const elapsed = Date.now() - (view.serverNow || Date.now());
    return Math.max(0, (view.positionMs || 0) + elapsed);
}

function shownPosition() {
    if (scrubbing) {
        return Number(scrub.value);
    }
    if (seekHold && view.revision === seekHold.revision) {
        return seekHold.positionMs;
    }
    const position = expectedPosition();
    if (view.durationMs && position > view.durationMs) {
        return view.durationMs;
    }
    return position;
}

function paintClock(position, duration) {
    const end = duration ? formatTime(duration) : '00:00';
    clockEl.textContent = `${formatTime(position)} / ${end}`;
}

function paintTransport() {
    const current = view.current;
    nowTitle.textContent = current?.title || 'Nothing queued';
    const position = shownPosition();
    const duration = view.durationMs;
    playStateEl.textContent = statusLabel(view.status);
    paintClock(position, duration);
    if (!scrubbing) {
        if (duration) {
            scrub.max = String(duration);
            scrub.value = String(Math.min(position, duration));
        } else {
            scrub.max = String(Math.max(position + 15_000, 30_000));
            scrub.value = String(position);
        }
    }
    const playing = view.status === 'playing';
    toggleBtn.dataset.mode = playing ? 'pause' : 'play';
    toggleBtn.title = playing ? 'Pause' : 'Play';
    toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const stopped = !playing && view.status !== 'paused';
    toggleBtn.classList.toggle('active', playing);
    toggleBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    stopBtn.classList.toggle('active', stopped);
    stopBtn.setAttribute('aria-pressed', stopped ? 'true' : 'false');
    if (!voluming && Number.isFinite(view.volume)) {
        volumeInput.value = String(view.volume);
    }
    const hasTrack = Boolean(current);
    $('back').disabled = !hasTrack || busy;
    $('forward').disabled = !hasTrack || busy;
    $('skip').disabled = !hasTrack || busy;
    $('previous').disabled = (!hasTrack && !view.canPrevious) || busy;
    toggleBtn.disabled = !hasTrack || busy;
    stopBtn.disabled = !hasTrack || busy;
    scrub.disabled = !hasTrack;
    volumeInput.disabled = !guildSelect.value || busy;
}

function queueRows() {
    const rows = [];
    if (view.current) {
        rows.push({ ...view.current, index: 0, playing: true });
    }
    for (const item of view.upcoming) {
        rows.push({ ...item, index: item.index + 1, playing: false });
    }
    return rows;
}

function finishPointerDrag(event) {
    if (!pointerDrag) return;
    const info = pointerDrag;
    pointerDrag = null;
    dragging = false;
    info.row.classList.remove('dragging');
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.queue-item');
    clearDropMarks();
    if (!info.active || !target) {
        paintQueue();
        return;
    }
    const index = Number(target.dataset.index);
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    let to = before ? index : index + 1;
    if (info.from < to) to -= 1;
    if (Number.isInteger(info.from) && info.from !== to) {
        control('stream_reorder', { fromIndex: info.from, toIndex: to });
    } else {
        paintQueue();
    }
}

function clearDropMarks() {
    queueList.querySelectorAll('.drop-before, .drop-after').forEach((row) => {
        row.classList.remove('drop-before', 'drop-after');
    });
}

function paintQueue() {
    if (dragging) return;
    queueList.replaceChildren();
    const rows = queueRows();
    if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'The stream queue is empty. Add a link or a search above.';
        queueList.appendChild(empty);
        return;
    }
    if (rows.length > 1) {
        const hint = document.createElement('p');
        hint.className = 'hint queue-hint';
        hint.textContent = 'Drag videos into the order you want. Everyone follows this queue.';
        queueList.appendChild(hint);
    }
    rows.forEach((item) => {
        const row = document.createElement('div');
        row.className = item.playing ? 'queue-item is-playing' : 'queue-item';
        row.dataset.index = String(item.index);
        const grip = document.createElement('span');
        grip.className = 'queue-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.textContent = '≡';
        const num = document.createElement('span');
        num.className = 'queue-num';
        num.textContent = item.playing ? 'Now' : String(item.index + 1);
        const title = document.createElement('span');
        title.className = 'queue-title';
        title.textContent = item.title || 'YouTube';
        const time = document.createElement('span');
        time.className = 'queue-time';
        time.textContent = item.durationMs ? formatTime(item.durationMs) : '';
        row.append(grip, num, title, time);
        if (!item.playing) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'quiet';
            remove.textContent = 'Remove';
            remove.disabled = busy;
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                control('stream_remove', { index: item.index - 1 });
            });
            row.append(remove);
        }
        row.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || rows.length < 2 || busy) return;
            if (event.target.closest('button')) return;
            pointerDrag = {
                from: item.index,
                startY: event.clientY,
                row,
                active: false,
            };
            try {
                row.setPointerCapture(event.pointerId);
            } catch {
                /* the row can still drag without capture */
            }
        });
        row.addEventListener('pointermove', (event) => {
            if (!pointerDrag || pointerDrag.row !== row) return;
            if (!pointerDrag.active && Math.abs(event.clientY - pointerDrag.startY) < 4) return;
            if (!pointerDrag.active) {
                pointerDrag.active = true;
                dragging = true;
                row.classList.add('dragging');
            }
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.queue-item');
            clearDropMarks();
            if (!target) return;
            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            target.classList.add(before ? 'drop-before' : 'drop-after');
        });
        row.addEventListener('pointerup', (event) => finishPointerDrag(event));
        row.addEventListener('pointercancel', (event) => finishPointerDrag(event));
        queueList.appendChild(row);
    });
}

function playerSeconds() {
    try {
        const time = player?.getCurrentTime?.();
        return Number.isFinite(time) ? time * 1000 : null;
    } catch {
        return null;
    }
}

function playerState() {
    try {
        return player?.getPlayerState?.();
    } catch {
        return null;
    }
}

function applyVolume() {
    if (!playerReady || voluming || !Number.isFinite(view.volume)) return;
    if (appliedVolume === view.volume) return;
    try {
        player.setVolume(view.volume);
        appliedVolume = view.volume;
    } catch {
        /* player is still starting */
    }
}

function loadCurrent(seconds) {
    const id = view.current.videoId;
    const args = { videoId: id, startSeconds: Math.max(0, seconds / 1000) };
    if (view.status === 'playing') {
        player.loadVideoById(args);
    } else {
        player.cueVideoById(args);
    }
    appliedVideoId = id;
    appliedRevision = view.revision;
    settleUntil = Date.now() + SEEK_SETTLE_MS;
    endedFor = '';
}

function follow() {
    if (!joined || !playerReady || !player) return;
    const current = view.current;
    if (!current) {
        if (appliedVideoId) {
            try {
                player.stopVideo();
            } catch {
                /* already stopped */
            }
            appliedVideoId = null;
            appliedRevision = -1;
        }
        applyVolume();
        return;
    }
    const seconds = shownPosition();
    if (appliedVideoId !== current.videoId) {
        loadCurrent(seconds);
        applyVolume();
        return;
    }
    if (appliedRevision !== view.revision) {
        try {
            player.seekTo(Math.max(0, seconds / 1000), true);
            if (view.status === 'playing') player.playVideo();
            else player.pauseVideo();
        } catch {
            loadCurrent(seconds);
            return;
        }
        appliedRevision = view.revision;
        settleUntil = Date.now() + SEEK_SETTLE_MS;
        applyVolume();
        return;
    }
    if (seekHold && view.revision === seekHold.revision) {
        applyVolume();
        return;
    }
    if (Date.now() < settleUntil) {
        applyVolume();
        return;
    }
    const state = playerState();
    const local = playerSeconds();
    const playingState = window.YT?.PlayerState?.PLAYING;
    const pausedState = window.YT?.PlayerState?.PAUSED;
    const bufferingState = window.YT?.PlayerState?.BUFFERING;
    const cuedState = window.YT?.PlayerState?.CUED;
    if (view.status === 'playing') {
        if (state === pausedState || state === cuedState || state === -1) {
            player.playVideo();
        } else if (
            state === playingState &&
            local != null &&
            Math.abs(local - expectedPosition()) > DRIFT_MS
        ) {
            player.seekTo(expectedPosition() / 1000, true);
            settleUntil = Date.now() + SEEK_SETTLE_MS;
        }
    } else if (state === playingState || state === bufferingState) {
        player.pauseVideo();
    }
    applyVolume();
}

async function refreshStatus() {
    try {
        const response = await fetch('/api/status');
        latest = await response.json();
        paintSelectors();
        paintPresence();
    } catch (err) {
        situationEl.textContent = `Status unavailable: ${err.message || err}`;
    }
}

async function refreshStream() {
    if (!guildSelect.value) {
        view = emptyView();
        paintTransport();
        paintQueue();
        follow();
        return;
    }
    try {
        const response = await fetch(`/api/stream?guildId=${encodeURIComponent(guildSelect.value)}`);
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.message || 'The stream is unavailable.');
        }
        if (seekHold && (data.revision !== seekHold.revision || Date.now() > seekHold.until)) {
            seekHold = null;
        }
        view = data;
        paintTransport();
        paintQueue();
        follow();
    } catch (err) {
        if (!scrubbing) {
            setResult(err.message || String(err), 'err');
        }
    }
}

async function control(action, extra) {
    if (busy) return;
    if (!guildSelect.value) {
        setResult('Pick a server.', 'err');
        return;
    }
    busy = true;
    paintTransport();
    setResult('Working…', 'pending');
    try {
        const response = await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                guildId: guildSelect.value,
                ...extra,
            }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.message || 'That did not work.');
        }
        setResult(data.message || 'Done.', 'ok');
        await refreshStream();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        busy = false;
        paintTransport();
        paintQueue();
    }
}

function reportEnded(videoId) {
    if (!videoId || !guildSelect.value || endedFor === videoId) return;
    endedFor = videoId;
    fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'stream_ended',
            guildId: guildSelect.value,
            videoId,
        }),
    })
        .then(() => refreshStream())
        .catch(() => {});
}

$('add').addEventListener('click', async () => {
    const query = $('query').value.trim();
    if (!query) {
        setResult('Enter a YouTube link or search.', 'err');
        return;
    }
    await control('stream_add', { query });
    if (resultEl.classList.contains('ok')) {
        $('query').value = '';
    }
});

$('query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('add').click();
});

toggleBtn.addEventListener('click', () => {
    control(view.status === 'playing' ? 'stream_pause' : 'stream_play');
});
$('stop').addEventListener('click', () => control('stream_stop'));
$('previous').addEventListener('click', () => control('stream_previous'));
$('back').addEventListener('click', () => control('stream_back'));
$('forward').addEventListener('click', () => control('stream_forward'));
$('skip').addEventListener('click', () => control('stream_skip'));

scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
});
scrub.addEventListener('input', () => {
    paintClock(Number(scrub.value), view.durationMs);
});
scrub.addEventListener('change', () => {
    const positionMs = Number(scrub.value);
    scrubbing = false;
    seekHold = { positionMs, revision: view.revision, until: Date.now() + 8000 };
    paintClock(positionMs, view.durationMs);
    control('stream_seek', { positionMs });
});
scrub.addEventListener('pointercancel', () => {
    scrubbing = false;
});

volumeInput.addEventListener('pointerdown', () => {
    voluming = true;
});
volumeInput.addEventListener('change', () => {
    voluming = false;
    const percent = Math.round(Number(volumeInput.value) / 5) * 5;
    volumeInput.value = String(Math.min(100, Math.max(0, percent)));
    control('stream_volume', { percent: Number(volumeInput.value) });
});
volumeInput.addEventListener('pointercancel', () => {
    voluming = false;
});

joinBtn.addEventListener('click', () => {
    joined = true;
    joinBtn.hidden = true;
    follow();
});

guildSelect.addEventListener('change', () => {
    writeSelection({
        guildId: guildSelect.value,
        textChannelId: readSelection().textChannelId || '',
        voiceChannelId: readSelection().voiceChannelId || '',
        memberId: '',
    });
    appliedVideoId = null;
    appliedRevision = -1;
    paintSelectors();
    paintPresence();
    refreshStream();
});

window.onYouTubeIframeAPIReady = () => {
    player = new window.YT.Player('player', {
        playerVars: {
            enablejsapi: 1,
            origin: window.location.origin,
            rel: 0,
            modestbranding: 1,
            controls: 0,
            disablekb: 1,
            playsinline: 1,
            fs: 0,
        },
        events: {
            onReady: () => {
                playerReady = true;
                follow();
            },
            onStateChange: (event) => {
                if (event.data !== window.YT?.PlayerState?.ENDED) return;
                if (!joined || Date.now() < settleUntil) return;
                if (view.status !== 'playing' || !view.current) return;
                reportEnded(view.current.videoId);
            },
            onError: () => {
                setResult('YouTube will not embed that video. Skip it to keep the room moving.', 'err');
            },
        },
    });
};

const iframeApi = document.createElement('script');
iframeApi.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(iframeApi);

refreshStatus().then(refreshStream);
setInterval(refreshStatus, 4000);
setInterval(refreshStream, 400);
setInterval(() => {
    if (!scrubbing && view.status === 'playing') paintTransport();
}, 200);
