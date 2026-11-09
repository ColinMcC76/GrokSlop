const $ = (id) => document.getElementById(id);

const guildSelect = $('guild');
const textSelect = $('textChannel');
const voiceSelect = $('voiceChannel');
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

let latest = null;
let view = emptyView();
let scrubbing = false;
let voluming = false;
let dragging = false;
let pointerDrag = null;
let busy = false;
let seekHold = null;

function emptyView() {
    return {
        status: 'idle',
        positionMs: 0,
        durationMs: null,
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
    if (status === 'buffering') return 'Buffering';
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
    const guild = selectedGuild();
    const sameGuild = Boolean(guild && saved.guildId === guild.id);
    fillSelect(
        textSelect,
        guild?.textChannels || [],
        'Text channel',
        (channel) => `#${channel.name}`,
        sameGuild ? saved.textChannelId : ''
    );
    fillSelect(
        voiceSelect,
        guild?.voiceChannels || [],
        'Voice channel',
        (channel) => channel.name,
        sameGuild ? saved.voiceChannelId : ''
    );
}

function paintPresence() {
    if (!latest?.ready) {
        presenceEl.textContent = 'Offline';
        presenceEl.className = 'presence offline';
        taglineEl.textContent = latest?.botName ? `${latest.botName} · queue` : 'Queue';
        situationEl.textContent = 'Not online yet. The queue will show once Discord connects.';
        return;
    }
    presenceEl.textContent = 'Online';
    presenceEl.className = 'presence online';
    const ping = typeof latest.ping === 'number' && latest.ping >= 0 ? `${latest.ping}ms` : 'ping —';
    taglineEl.textContent = `${latest.tag || latest.botName} · ${ping}`;
    const guild = selectedGuild();
    if (!guild) {
        situationEl.textContent = 'Pick a server.';
        return;
    }
    situationEl.textContent = guild.voice
        ? `In ${guild.voice.channelName}. Add sends songs there.`
        : 'Not in voice. Pick a voice channel and Add will join it.';
}

function paintClock(position, duration) {
    const end = duration ? formatTime(duration) : '00:00';
    clockEl.textContent = `${formatTime(position)} / ${end}`;
}

function paintTransport() {
    const current = view.current;
    nowTitle.textContent = current?.title || 'Nothing queued';
    const position = scrubbing ? Number(scrub.value) : view.positionMs || 0;
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
    const playing = view.status === 'playing' || view.status === 'buffering';
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
        control('queue_reorder', { fromIndex: info.from, toIndex: to });
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
        empty.textContent = 'The queue is empty. Add a link or a search above.';
        queueList.appendChild(empty);
        return;
    }
    if (rows.length > 1) {
        const hint = document.createElement('p');
        hint.className = 'hint queue-hint';
        hint.textContent = 'Drag songs into the order you want.';
        queueList.appendChild(hint);
    }
    rows.forEach((item) => {
        const row = document.createElement('div');
        row.className = item.playing ? 'queue-item is-playing' : 'queue-item';
        row.dataset.index = String(item.index);
        row.draggable = false;
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
            remove.draggable = false;
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                control('queue_remove', { index: item.index - 1 });
            });
            remove.addEventListener('dragstart', (event) => event.preventDefault());
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
            } catch {}
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

async function refreshQueue() {
    if (!guildSelect.value) {
        view = emptyView();
        paintTransport();
        paintQueue();
        return;
    }
    try {
        const response = await fetch(`/api/queue?guildId=${encodeURIComponent(guildSelect.value)}`);
        const data = await response.json();
        if (!response.ok || !data.ok) {
            if (response.status !== 503 && !scrubbing) {
                setResult(data.message || 'Could not load the queue.', 'err');
            }
            return;
        }
        if (seekHold && data.status !== 'stopped' && data.status !== 'paused') {
            const reported = data.positionMs || 0;
            if (Date.now() > seekHold.until || Math.abs(reported - seekHold.positionMs) < 1500) {
                seekHold = null;
            } else {
                data.positionMs = seekHold.positionMs;
            }
        } else {
            seekHold = null;
        }
        view = data;
        paintTransport();
        paintQueue();
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
                textChannelId: textSelect.value,
                voiceChannelId: voiceSelect.value,
                ...extra,
            }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.message || 'That did not work.');
        }
        setResult(data.message || 'Done.', 'ok');
        await refreshQueue();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        busy = false;
        paintTransport();
        paintQueue();
    }
}

$('add').addEventListener('click', async () => {
    const query = $('query').value.trim();
    if (!query) {
        setResult('Enter a YouTube link or search.', 'err');
        return;
    }
    await control('play', { query });
    if (resultEl.classList.contains('ok')) {
        $('query').value = '';
    }
});

$('query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        $('add').click();
    }
});

toggleBtn.addEventListener('click', () => {
    const playing = view.status === 'playing' || view.status === 'buffering';
    control(playing ? 'queue_pause' : 'queue_play');
});
$('stop').addEventListener('click', () => control('queue_stop'));
$('previous').addEventListener('click', () => control('queue_previous'));
$('back').addEventListener('click', () => control('queue_back'));
$('forward').addEventListener('click', () => control('queue_forward'));
$('skip').addEventListener('click', () => control('skip'));

scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
});
scrub.addEventListener('input', () => {
    paintClock(Number(scrub.value), view.durationMs);
});
scrub.addEventListener('change', () => {
    const positionMs = Number(scrub.value);
    scrubbing = false;
    seekHold = { positionMs, until: Date.now() + 8000 };
    view.positionMs = positionMs;
    paintClock(positionMs, view.durationMs);
    control('queue_seek', { positionMs });
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
    control('volume', { percent: Number(volumeInput.value) });
});
volumeInput.addEventListener('pointercancel', () => {
    voluming = false;
});

function persistSelectors() {
    writeSelection({
        guildId: guildSelect.value,
        textChannelId: textSelect.value,
        voiceChannelId: voiceSelect.value,
    });
}

guildSelect.addEventListener('change', () => {
    textSelect.value = '';
    voiceSelect.value = '';
    writeSelection({
        guildId: guildSelect.value,
        textChannelId: '',
        voiceChannelId: '',
        memberId: '',
    });
    paintSelectors();
    paintPresence();
    refreshQueue();
});
textSelect.addEventListener('change', persistSelectors);
voiceSelect.addEventListener('change', persistSelectors);

refreshStatus().then(refreshQueue);
setInterval(refreshStatus, 4000);
setInterval(refreshQueue, 1000);
