const $ = (id) => document.getElementById(id);

const guildSelect = $('guild');
const voiceSelect = $('voiceChannel');
const resultEl = $('result');
const situationEl = $('situation');
const presenceEl = $('presence');
const taglineEl = $('tagline');
const grid = $('grid');

let latest = null;
let soundbites = [];
let busyId = null;

function setResult(text, kind) {
    resultEl.textContent = text;
    resultEl.className = `result ${kind || ''}`.trim();
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    if (!latest) return null;
    return latest.guilds.find((guild) => guild.id === guildSelect.value) || null;
}

function paintStatus() {
    if (!latest?.ready) {
        presenceEl.textContent = 'Offline';
        presenceEl.className = 'presence offline';
        taglineEl.textContent = latest?.botName ? `${latest.botName} · soundboard` : 'Soundboard';
        situationEl.textContent = 'Not online yet. You can still add and edit soundbites.';
    } else {
        presenceEl.textContent = 'Online';
        presenceEl.className = 'presence online';
        const ping = typeof latest.ping === 'number' && latest.ping >= 0 ? `${latest.ping}ms` : 'ping —';
        taglineEl.textContent = `${latest.tag || latest.botName} · ${ping}`;
        const guild = selectedGuild();
        situationEl.textContent = guild?.voice
            ? `In ${guild.voice.channelName}. Play sends the clip there, unless you pick a different voice channel.`
            : 'Not in voice. Pick a voice channel and Play will join it.';
    }
    const guilds = latest?.guilds || [];
    fillSelect(guildSelect, guilds, guilds.length ? 'Select server' : 'No servers', (guild) => guild.name);
    if (!guildSelect.value && guilds.length === 1) {
        guildSelect.value = guilds[0].id;
    }
    const guild = selectedGuild();
    fillSelect(
        voiceSelect,
        guild?.voiceChannels || [],
        'Voice channel',
        (channel) => channel.name
    );
}

async function refreshStatus() {
    try {
        const response = await fetch('/api/status');
        latest = await response.json();
        paintStatus();
    } catch (err) {
        situationEl.textContent = `Status unavailable: ${err.message || err}`;
    }
}

function uploadHeaders(name, file) {
    return {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Soundbite-Name': encodeURIComponent(name),
        'X-Soundbite-Filename': encodeURIComponent(file.name || 'clip.mp3'),
    };
}

async function readError(response) {
    try {
        const data = await response.json();
        return data.message || `Request failed (${response.status})`;
    } catch {
        return `Request failed (${response.status})`;
    }
}

async function loadBites() {
    const response = await fetch('/api/soundbites');
    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Could not load soundbites.');
    }
    soundbites = data.soundbites || [];
    paintBites();
}

function paintBites() {
    grid.replaceChildren();
    if (soundbites.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No soundbites yet. Add one above.';
        grid.appendChild(empty);
        return;
    }
    for (const bite of soundbites) {
        grid.appendChild(renderBite(bite));
    }
}

function renderBite(bite) {
    const card = document.createElement('article');
    card.className = 'bite';

    const title = document.createElement('h3');
    title.textContent = bite.name;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `${bite.ext.replace('.', '')} · ${formatBytes(bite.bytes)}`;

    const row = document.createElement('div');
    row.className = 'row';

    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = busyId === bite.id ? 'Playing…' : 'Play';
    play.disabled = Boolean(busyId);
    play.addEventListener('click', () => playBite(bite, play));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'quiet';
    edit.textContent = 'Edit';
    edit.disabled = Boolean(busyId);
    edit.addEventListener('click', () => startEdit(card, bite));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.disabled = Boolean(busyId);
    remove.addEventListener('click', () => removeBite(bite));

    row.append(play, edit, remove);
    card.append(title, meta, row);
    return card;
}

function startEdit(card, bite) {
    card.replaceChildren();
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 48;
    name.value = bite.name;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.mp3,.wav,.ogg,.webm,.m4a,.flac,.aac,audio/*';
    const fileLabel = document.createElement('p');
    fileLabel.className = 'meta';
    fileLabel.textContent = 'Leave the file empty to keep the current audio.';

    const row = document.createElement('div');
    row.className = 'row';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'quiet';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', paintBites);
    save.addEventListener('click', () => saveEdit(bite, name.value, file.files[0], save));
    row.append(save, cancel);
    card.append(name, file, fileLabel, row);
}

async function saveEdit(bite, name, file, button) {
    button.disabled = true;
    setResult('Saving…', 'pending');
    try {
        const renamed = await fetch(`/api/soundbites/${bite.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (!renamed.ok) {
            throw new Error(await readError(renamed));
        }
        if (file) {
            const replaced = await fetch(`/api/soundbites/${bite.id}/audio`, {
                method: 'PUT',
                headers: uploadHeaders(name, file),
                body: file,
            });
            if (!replaced.ok) {
                throw new Error(await readError(replaced));
            }
        }
        setResult(`Saved “${name.trim()}”.`, 'ok');
        await loadBites();
    } catch (err) {
        setResult(err.message || String(err), 'err');
        button.disabled = false;
    }
}

async function removeBite(bite) {
    if (!window.confirm(`Delete “${bite.name}”?`)) return;
    setResult('Deleting…', 'pending');
    try {
        const response = await fetch(`/api/soundbites/${bite.id}`, { method: 'DELETE' });
        if (!response.ok) {
            throw new Error(await readError(response));
        }
        setResult(`Deleted “${bite.name}”.`, 'ok');
        await loadBites();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    }
}

async function playBite(bite, button) {
    if (busyId) return;
    busyId = bite.id;
    button.disabled = true;
    button.textContent = 'Playing…';
    paintBites();
    setResult(`Playing “${bite.name}”…`, 'pending');
    try {
        const response = await fetch(`/api/soundbites/${bite.id}/play`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                guildId: guildSelect.value,
                voiceChannelId: voiceSelect.value,
            }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.message || 'Could not play that soundbite.');
        }
        setResult(data.message || `Played “${bite.name}”.`, 'ok');
        await refreshStatus();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        busyId = null;
        paintBites();
    }
}

$('create').addEventListener('click', async () => {
    const name = $('newName').value;
    const file = $('newFile').files[0];
    if (!name.trim() || !file) {
        setResult('Enter a name and choose an audio file.', 'err');
        return;
    }
    $('create').disabled = true;
    setResult('Adding…', 'pending');
    try {
        const response = await fetch('/api/soundbites', {
            method: 'POST',
            headers: uploadHeaders(name, file),
            body: file,
        });
        if (!response.ok) {
            throw new Error(await readError(response));
        }
        $('newName').value = '';
        $('newFile').value = '';
        const data = await response.json();
        setResult(`Added “${data.soundbite.name}”.`, 'ok');
        await loadBites();
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        $('create').disabled = false;
    }
});

guildSelect.addEventListener('change', () => {
    voiceSelect.value = '';
    paintStatus();
});

refreshStatus();
setInterval(refreshStatus, 4000);
loadBites().catch((err) => setResult(err.message || String(err), 'err'));
