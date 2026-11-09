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
let serverPlayingId = null;
let editing = false;
let stopping = false;

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

function selectedGuild() {
    if (!latest) return null;
    return latest.guilds.find((guild) => guild.id === guildSelect.value) || null;
}

function paintStatus() {
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
        voiceSelect,
        guild?.voiceChannels || [],
        'Voice channel',
        (channel) => channel.name,
        sameGuild ? saved.voiceChannelId : ''
    );
    if (!latest?.ready) {
        presenceEl.textContent = 'Offline';
        presenceEl.className = 'presence offline';
        taglineEl.textContent = latest?.botName ? `${latest.botName} · soundboard` : 'Soundboard';
        situationEl.textContent = 'Not online yet. You can still add and edit soundbites.';
        return;
    }
    presenceEl.textContent = 'Online';
    presenceEl.className = 'presence online';
    const ping = typeof latest.ping === 'number' && latest.ping >= 0 ? `${latest.ping}ms` : 'ping —';
    taglineEl.textContent = `${latest.tag || latest.botName} · ${ping}`;
    situationEl.textContent = guild?.voice
        ? `In ${guild.voice.channelName}. Play sends the clip there, unless you pick a different voice channel.`
        : 'Not in voice. Pick a voice channel and Play will join it.';
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
    serverPlayingId = data.playing?.id || null;
    if (!editing) {
        paintBites();
    }
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

    const activeId = busyId || serverPlayingId;
    const playing = activeId === bite.id;

    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = playing ? 'Stop' : 'Play';
    play.className = playing ? 'danger' : '';
    play.disabled = Boolean(activeId) && !playing;
    play.addEventListener('click', () => {
        if (playing) {
            stopPlayback();
            return;
        }
        playBite(bite);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'quiet';
    edit.textContent = 'Edit';
    edit.disabled = Boolean(activeId);
    edit.addEventListener('click', () => startEdit(card, bite));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.disabled = Boolean(activeId);
    remove.addEventListener('click', () => removeBite(bite));

    row.append(play, edit, remove);
    card.append(title, meta, row);
    return card;
}

function startEdit(card, bite) {
    editing = true;
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
    cancel.addEventListener('click', () => {
        editing = false;
        paintBites();
    });
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
        editing = false;
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

async function playBite(bite) {
    if (busyId || serverPlayingId) return;
    busyId = bite.id;
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
        serverPlayingId = null;
        paintBites();
    }
}

async function stopPlayback() {
    if (stopping) return;
    stopping = true;
    const button = $('stop');
    button.disabled = true;
    setResult('Stopping…', 'pending');
    try {
        const response = await fetch('/api/soundbites/stop', { method: 'POST' });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.message || 'Could not stop playback.');
        }
        setResult(data.message || 'Stopped.', 'ok');
    } catch (err) {
        setResult(err.message || String(err), 'err');
    } finally {
        stopping = false;
        button.disabled = false;
    }
}

async function refreshPlaying() {
    try {
        const response = await fetch('/api/soundbites');
        const data = await response.json();
        if (!response.ok || !data.ok) return;
        const next = data.playing?.id || null;
        if (next === serverPlayingId) return;
        serverPlayingId = next;
        if (!editing && !busyId) {
            paintBites();
        }
    } catch {
        /* the status line already reports a dead panel */
    }
}

function nameFromFile(file) {
    return String(file.name || '')
        .replace(/\.[^.]+$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
}

function syncFileHint() {
    const files = [...$('newFile').files];
    const nameInput = $('newName');
    const hint = $('fileHint');
    if (files.length > 1) {
        nameInput.disabled = true;
        const names = files.map((file) => nameFromFile(file) || file.name);
        const preview = names.slice(0, 4).join(', ');
        const extra = names.length > 4 ? `, and ${names.length - 4} more` : '';
        hint.textContent = `${files.length} files: ${preview}${extra}.`;
        return;
    }
    nameInput.disabled = false;
    hint.textContent = files.length === 1
        ? 'This file uses the name above.'
        : 'One file uses the name above. Several files are named from each file.';
}

async function addSoundbite(name, file) {
    const response = await fetch('/api/soundbites', {
        method: 'POST',
        headers: uploadHeaders(name, file),
        body: file,
    });
    if (!response.ok) {
        throw new Error(await readError(response));
    }
    const data = await response.json();
    return data.soundbite.name;
}

$('newFile').addEventListener('change', syncFileHint);

$('create').addEventListener('click', async () => {
    const files = [...$('newFile').files];
    const multiple = files.length > 1;
    const typed = $('newName').value;
    if (files.length === 0 || (!multiple && !typed.trim())) {
        setResult('Enter a name and choose an audio file.', 'err');
        return;
    }
    $('create').disabled = true;
    setResult(multiple ? `Adding ${files.length} soundbites…` : 'Adding…', 'pending');
    const added = [];
    const failed = [];
    try {
        for (const file of files) {
            const name = multiple ? nameFromFile(file) : typed;
            if (!name) {
                failed.push(`${file.name || 'file'}: that file needs a name`);
                continue;
            }
            try {
                added.push(await addSoundbite(name, file));
            } catch (err) {
                failed.push(`${file.name || 'file'}: ${err.message || err}`);
            }
        }
        if (added.length) {
            $('newName').value = '';
            $('newFile').value = '';
            syncFileHint();
            await loadBites();
        }
        const addedText = added.length === 1
            ? `Added “${added[0]}”.`
            : added.length
                ? `Added ${added.length} soundbites: ${added.map((name) => `“${name}”`).join(', ')}.`
                : '';
        const failedText = failed.length ? `Failed ${failed.join('; ')}.` : '';
        setResult(
            [addedText, failedText].filter(Boolean).join(' ') || 'Nothing was added.',
            added.length ? 'ok' : 'err'
        );
    } finally {
        $('create').disabled = false;
    }
});

guildSelect.addEventListener('change', () => {
    voiceSelect.value = '';
    writeSelection({
        guildId: guildSelect.value,
        textChannelId: '',
        voiceChannelId: '',
        memberId: '',
    });
    paintStatus();
});

voiceSelect.addEventListener('change', () => {
    const patch = { voiceChannelId: voiceSelect.value };
    if (guildSelect.value) {
        patch.guildId = guildSelect.value;
    }
    writeSelection(patch);
});

$('stop').addEventListener('click', () => stopPlayback());

refreshStatus();
setInterval(refreshStatus, 4000);
setInterval(refreshPlaying, 2000);
loadBites().catch((err) => setResult(err.message || String(err), 'err'));
