const $ = (id) => document.getElementById(id);

const guildSelect = $('guild');
const textSelect = $('textChannel');
const voiceSelect = $('voiceChannel');
const resultEl = $('result');
const situationEl = $('situation');
const presenceEl = $('presence');
const taglineEl = $('tagline');
const nowTitle = $('nowTitle');
const elapsedEl = $('elapsed');
const durationEl = $('duration');
const scrub = $('scrub');
const toggleBtn = $('toggle');
const queueList = $('queueList');

let latest = null;
let view = emptyView();
let scrubbing = false;
let busy = false;

function emptyView() {
    return {
        status: 'idle',
        positionMs: 0,
        durationMs: null,
        current: null,
        upcoming: [],
        total: 0,
    };
}

function setResult(text, kind) {
    resultEl.textContent = text;
    resultEl.className = `result ${kind || ''}`.trim();
}

function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '0:00';
    }
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
    }
    return `${minutes}:${seconds}`;
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

function paintTransport() {
    const current = view.current;
    nowTitle.textContent = current?.title || 'Nothing queued';
    const position = scrubbing ? Number(scrub.value) : view.positionMs || 0;
    const duration = view.durationMs;
    elapsedEl.textContent = formatTime(position);
    durationEl.textContent = duration ? formatTime(duration) : '—';
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
    toggleBtn.textContent = playing ? 'Pause' : 'Play';
    const hasTrack = Boolean(current);
    $('back').disabled = !hasTrack || busy;
    $('forward').disabled = !hasTrack || busy;
    $('skip').disabled = !hasTrack || busy;
    toggleBtn.disabled = !hasTrack || busy;
    scrub.disabled = !hasTrack || busy;
}

function paintQueue() {
    queueList.replaceChildren();
    if (!view.upcoming.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = view.current
            ? 'Nothing else is queued.'
            : 'The queue is empty. Add a link or a search above.';
        queueList.appendChild(empty);
        return;
    }
    view.upcoming.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'queue-item';
        const num = document.createElement('span');
        num.className = 'queue-num';
        num.textContent = String(index + 1);
        const title = document.createElement('span');
        title.className = 'queue-title';
        title.textContent = item.title || 'YouTube';
        const time = document.createElement('span');
        time.className = 'queue-time';
        time.textContent = item.durationMs ? formatTime(item.durationMs) : '';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quiet';
        remove.textContent = 'Remove';
        remove.disabled = busy;
        remove.addEventListener('click', () => control('queue_remove', { index }));
        row.append(num, title, time, remove);
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
$('back').addEventListener('click', () => control('queue_back'));
$('forward').addEventListener('click', () => control('queue_forward'));
$('skip').addEventListener('click', () => control('skip'));

scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
});
scrub.addEventListener('input', () => {
    elapsedEl.textContent = formatTime(Number(scrub.value));
});
scrub.addEventListener('change', () => {
    const positionMs = Number(scrub.value);
    scrubbing = false;
    control('queue_seek', { positionMs });
});
scrub.addEventListener('pointerup', () => {
    scrubbing = false;
});
scrub.addEventListener('pointercancel', () => {
    scrubbing = false;
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
