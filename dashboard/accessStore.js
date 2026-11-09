const fs = require('node:fs');
const path = require('node:path');

const SNOWFLAKE = /^\d{17,20}$/;

/** @type {{ filePath: string, data: { pending: Person[], approved: Person[] } } | null} */
let cache = null;

/**
 * @typedef {{ id: string, username: string, globalName: string, requestedAt?: string, approvedAt?: string }} Person
 */

function accessPath() {
    return (
        process.env.DASHBOARD_ACCESS_PATH ||
        path.join(__dirname, '..', 'data', 'dashboard-access.json')
    );
}

function cleanName(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 64);
}

function stamp(value) {
    return typeof value === 'string' ? value.slice(0, 40) : '';
}

/**
 * @param {unknown} raw
 * @param {'requestedAt' | 'approvedAt'} stampKey
 * @returns {Person | null}
 */
function personFrom(raw, stampKey) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const id = String(raw.id || '');
    if (!SNOWFLAKE.test(id)) {
        return null;
    }
    const person = {
        id,
        username: cleanName(raw.username) || id,
        globalName: cleanName(raw.globalName),
    };
    const when = stamp(raw[stampKey]);
    if (when) {
        person[stampKey] = when;
    }
    return person;
}

function emptyData() {
    return { pending: [], approved: [] };
}

function read() {
    const filePath = accessPath();
    if (cache && cache.filePath === filePath) {
        return cache.data;
    }
    let data = emptyData();
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const pending = Array.isArray(parsed?.pending)
            ? parsed.pending.map((row) => personFrom(row, 'requestedAt')).filter(Boolean)
            : [];
        const approved = Array.isArray(parsed?.approved)
            ? parsed.approved.map((row) => personFrom(row, 'approvedAt')).filter(Boolean)
            : [];
        data = { pending, approved };
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            console.warn('[dashboard] could not read access list:', err?.message || err);
        }
    }
    cache = { filePath, data };
    return data;
}

function save() {
    const data = read();
    const filePath = accessPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, filePath);
}

function copyPerson(person) {
    return { ...person };
}

function displayName(person) {
    if (person.globalName && person.globalName !== person.username) {
        return `${person.globalName} (@${person.username})`;
    }
    return person.globalName || person.username || person.id;
}

function isSnowflake(id) {
    return SNOWFLAKE.test(String(id || ''));
}

function isApproved(id) {
    return read().approved.some((person) => person.id === id);
}

function isPending(id) {
    return read().pending.some((person) => person.id === id);
}

/**
 * @param {{ id: string, username?: string, globalName?: string }} user
 */
function rememberPending(user) {
    if (!isSnowflake(user.id) || isApproved(user.id)) {
        return;
    }
    const data = read();
    const next = {
        id: user.id,
        username: cleanName(user.username) || user.id,
        globalName: cleanName(user.globalName),
        requestedAt: new Date().toISOString(),
    };
    const index = data.pending.findIndex((person) => person.id === user.id);
    if (index >= 0) {
        data.pending[index] = next;
    } else {
        data.pending.push(next);
    }
    save();
}

function list() {
    const data = read();
    const byName = (a, b) => displayName(a).localeCompare(displayName(b));
    return {
        pending: data.pending.map(copyPerson).sort(byName),
        approved: data.approved.map(copyPerson).sort(byName),
    };
}

/**
 * @param {unknown} op
 * @param {unknown} id
 * @param {string} ownerId
 */
function change(op, id, ownerId) {
    const userId = String(id || '');
    if (!isSnowflake(userId)) {
        return { ok: false, status: 400, message: 'That Discord id is not valid.' };
    }
    if (userId === ownerId) {
        return { ok: false, status: 400, message: 'You already have access.' };
    }
    const data = read();
    if (op === 'approve') {
        const index = data.pending.findIndex((person) => person.id === userId);
        if (index < 0 && !data.approved.some((person) => person.id === userId)) {
            return { ok: false, status: 404, message: 'That person is not waiting.' };
        }
        const source = index >= 0 ? data.pending[index] : data.approved.find((person) => person.id === userId);
        if (index >= 0) {
            data.pending.splice(index, 1);
        }
        data.approved = data.approved.filter((person) => person.id !== userId);
        data.approved.push({
            id: userId,
            username: source.username,
            globalName: source.globalName,
            approvedAt: new Date().toISOString(),
        });
        save();
        return { ok: true, status: 200, message: `Approved ${displayName(source)}.` };
    }
    if (op === 'deny') {
        const index = data.pending.findIndex((person) => person.id === userId);
        if (index < 0) {
            return { ok: false, status: 404, message: 'That person is not waiting.' };
        }
        const [removed] = data.pending.splice(index, 1);
        save();
        return { ok: true, status: 200, message: `Denied ${displayName(removed)}.` };
    }
    if (op === 'remove') {
        const index = data.approved.findIndex((person) => person.id === userId);
        if (index < 0) {
            return { ok: false, status: 404, message: 'That person is not approved.' };
        }
        const [removed] = data.approved.splice(index, 1);
        save();
        return {
            ok: true,
            status: 200,
            message: `Removed ${displayName(removed)}. They lose access on their next click.`,
        };
    }
    return { ok: false, status: 400, message: 'Unknown access action.' };
}

module.exports = {
    SNOWFLAKE,
    cleanName,
    isSnowflake,
    isApproved,
    isPending,
    rememberPending,
    list,
    change,
    displayName,
};
