const $ = (id) => document.getElementById(id);

const guildSelect = $('guild');
const textSelect = $('textChannel');
const voiceSelect = $('voiceChannel');
const memberSelect = $('member');
const resultEl = $('result');
const situationEl = $('situation');
const presenceEl = $('presence');
const taglineEl = $('tagline');
const volumeInput = $('volume');
const volumeLabel = $('volumeLabel');
const logEl = $('log');

let latest = null;
let busy = false;
let volumeEditing = false;

volumeInput.addEventListener('input', () => {
    volumeLabel.textContent = volumeInput.value;
});
volumeInput.addEventListener('pointerdown', () => {
    volumeEditing = true;
});
volumeInput.addEventListener('change', () => {
    volumeEditing = false;
    volumeLabel.textContent = volumeInput.value;
});

function setResult(text, kind) {
    resultEl.textContent = text;
    resultEl.className = `result ${kind || ''}`.trim();
}

function fillSelect(select, items, placeholder, labelFor) {
    const current = select.value;
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.appendChild(blank);
    for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = labelFor(item);
        select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}

function selectedGuild() {
    if (!latest) {
        return null;
    }
    return latest.guilds.find((guild) => guild.id === guildSelect.value) || null;
}

function paintSelectors() {
    const guilds = latest?.guilds || [];
    fillSelect(guildSelect, guilds, guilds.length ? 'Select server' : 'No servers', (guild) => guild.name);
    if (!guildSelect.value && guilds.length === 1) {
        guildSelect.value = guilds[0].id;
    }
    const guild = selectedGuild();
    fillSelect(
        textSelect,
        guild?.textChannels || [],
        'Text channel',
        (channel) => `#${channel.name}`
    );
    fillSelect(
        voiceSelect,
        guild?.voiceChannels || [],
        'Voice channel',
        (channel) => channel.name
    );
    fillSelect(memberSelect, guild?.members || [], 'Server memory / no member', (member) => {
        if (member.voiceChannelName) {
            return `${member.name} · ${member.voiceChannelName}`;
        }
        return member.name;
    });
    if (guild && !volumeEditing) {
        volumeInput.value = String(guild.volume ?? 100);
        volumeLabel.textContent = volumeInput.value;
    }
}

function paintSituation() {
    if (!latest?.ready) {
        presenceEl.textContent = 'Offline';
        presenceEl.className = 'presence offline';
        taglineEl.textContent = latest?.botName || 'GrokSlop';
        situationEl.textContent = 'Not online yet. Buttons will answer once Discord connects.';
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
    const bits = [
        guild.voice ? `In ${guild.voice.channelName}` : 'Not in voice',
        guild.nowPlaying ? `Now: ${guild.nowPlaying.title}` : 'Nothing playing',
        guild.queueCount ? `Queue ${guild.queueCount}` : null,
        guild.realtime ? 'Realtime on' : 'Realtime off',
        guild.spotify?.linked
            ? `Spotify ${guild.spotify.active ? 'running' : 'linked'}`
            : 'Spotify off',
        guild.persona ? `Persona ${guild.persona}` : 'Default persona',
    ].filter(Boolean);
    situationEl.textContent = bits.join('  ·  ');
}

async function refresh() {
    try {
        const response = await fetch('/api/status');
        latest = await response.json();
        paintSelectors();
        paintSituation();
    } catch (err) {
        situationEl.textContent = `Status unavailable: ${err.message || err}`;
    }
}

function payload(action) {
    return {
        action,
        guildId: guildSelect.value,
        textChannelId: textSelect.value,
        voiceChannelId: voiceSelect.value,
        memberId: memberSelect.value,
        query: $('ytQuery').value,
        text: $('sayText').value,
        prompt: $('equipPrompt').value,
        percent: Number(volumeInput.value),
        name: $('personaName').value,
        personaPrompt: $('personaPrompt').value,
        key: $('memKey').value,
        value: $('memValue').value,
        limit: Number($('sumLimit').value),
        channelInput: $('feedChannel').value,
        force: $('feedForce').checked,
        video: $('feedVideo').value,
        redirect: $('spotifyRedirect').value,
        introQuery: $('introQuery').value,
    };
}

async function run(action, button) {
    if (busy) {
        return;
    }
    busy = true;
    button.disabled = true;
    setResult('Working…', 'pending');
    try {
        const response = await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload(action)),
        });
        const data = await response.json();
        setResult(data.message || (data.ok ? 'Done.' : 'Failed.'), data.ok ? 'ok' : 'err');
        if (data.openUrl) {
            window.open(data.openUrl, '_blank', 'noopener');
        }
        await refresh();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        busy = false;
        button.disabled = false;
    }
}

document.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => run(button.dataset.action, button));
});

guildSelect.addEventListener('change', () => {
    textSelect.value = '';
    voiceSelect.value = '';
    memberSelect.value = '';
    paintSelectors();
    paintSituation();
});

function appendLog(text) {
    logEl.textContent = logEl.textContent
        ? `${logEl.textContent}\n${text}`
        : text;
    const lines = logEl.textContent.split('\n');
    if (lines.length > 400) {
        logEl.textContent = lines.slice(-400).join('\n');
    }
    logEl.scrollTop = logEl.scrollHeight;
}

const logs = new EventSource('/api/logs');
logs.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'snapshot') {
        logEl.textContent = (data.lines || []).map((line) => line.text).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
        return;
    }
    if (data.text) {
        appendLog(data.text);
    }
};

refresh();
setInterval(refresh, 4000);
