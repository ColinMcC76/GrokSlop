const db = require('../storage/db');

const MAX_PROMPT_LEN = 4000;

const insertPersona = db.prepare(`
    INSERT INTO guild_personas (guild_id, name, prompt, updated_at)
    VALUES (@guildId, @name, @prompt, @now)
    ON CONFLICT(guild_id, name) DO UPDATE SET
        prompt = excluded.prompt,
        updated_at = excluded.updated_at
`);

const deletePersonaStmt = db.prepare(`
    DELETE FROM guild_personas WHERE guild_id = ? AND name = ?
`);

const selectPersonas = db.prepare(`
    SELECT name, prompt, updated_at FROM guild_personas
    WHERE guild_id = ?
    ORDER BY name ASC
`);

const selectPersona = db.prepare(`
    SELECT prompt FROM guild_personas WHERE guild_id = ? AND name = ?
`);

const upsertSelection = db.prepare(`
    INSERT INTO guild_persona_selection (guild_id, persona_name)
    VALUES (@guildId, @personaName)
    ON CONFLICT(guild_id) DO UPDATE SET persona_name = excluded.persona_name
`);

const clearSelection = db.prepare(`
    DELETE FROM guild_persona_selection WHERE guild_id = ?
`);

const selectSelection = db.prepare(`
    SELECT persona_name FROM guild_persona_selection WHERE guild_id = ?
`);

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizePersonaName(raw) {
    const s = raw
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '');
    if (s.length < 1 || s.length > 32) {
        throw new Error(
            'Persona name must be 1–32 characters after normalization (letters, numbers, dashes, underscores).'
        );
    }
    return s;
}

/**
 * @param {string} prompt
 */
function validatePrompt(prompt) {
    const t = typeof prompt === 'string' ? prompt.trim() : '';
    if (!t) {
        throw new Error('Persona prompt cannot be empty.');
    }
    if (t.length > MAX_PROMPT_LEN) {
        throw new Error(`Persona prompt must be at most ${MAX_PROMPT_LEN} characters.`);
    }
    return t;
}

/**
 * @param {string} guildId
 * @param {string} nameRaw
 * @param {string} promptRaw
 */
function addPersona(guildId, nameRaw, promptRaw) {
    const name = normalizePersonaName(nameRaw);
    const prompt = validatePrompt(promptRaw);
    const now = Date.now();
    insertPersona.run({ guildId, name, prompt, now });
    return name;
}

/**
 * @param {string} guildId
 * @param {string} nameRaw
 * @returns {boolean}
 */
function removePersona(guildId, nameRaw) {
    const name = normalizePersonaName(nameRaw);
    const sel = selectSelection.get(guildId);
    if (sel?.persona_name === name) {
        clearSelection.run(guildId);
    }
    const info = deletePersonaStmt.run(guildId, name);
    return info.changes > 0;
}

/**
 * @param {string} guildId
 * @returns {{ name: string, preview: string, updatedAt: number }[]}
 */
function listPersonas(guildId) {
    return selectPersonas.all(guildId).map((row) => ({
        name: row.name,
        preview:
            row.prompt.length > 120 ? `${row.prompt.slice(0, 117)}...` : row.prompt,
        updatedAt: row.updated_at,
    }));
}

/**
 * @param {string} guildId
 * @param {string | null} nameRaw — null clears active persona (default bot only)
 */
function setActivePersona(guildId, nameRaw) {
    if (nameRaw == null || nameRaw === '') {
        clearSelection.run(guildId);
        return null;
    }
    const name = normalizePersonaName(nameRaw);
    const row = selectPersona.get(guildId, name);
    if (!row) {
        throw new Error(`No persona named **${name}** in this server. Use \`/persona list\`.`);
    }
    upsertSelection.run({ guildId, personaName: name });
    return name;
}

/**
 * @param {string} guildId
 * @returns {string | null}
 */
function getActivePersonaName(guildId) {
    const sel = selectSelection.get(guildId);
    if (!sel?.persona_name) {
        return null;
    }
    const row = selectPersona.get(guildId, sel.persona_name);
    if (!row) {
        clearSelection.run(guildId);
        return null;
    }
    return sel.persona_name;
}

/**
 * @param {string} guildId
 * @returns {string | null}
 */
function getActivePromptText(guildId) {
    const name = getActivePersonaName(guildId);
    if (!name) {
        return null;
    }
    const row = selectPersona.get(guildId, name);
    return row?.prompt ?? null;
}

module.exports = {
    addPersona,
    removePersona,
    listPersonas,
    setActivePersona,
    getActivePersonaName,
    getActivePromptText,
    normalizePersonaName,
    MAX_PROMPT_LEN,
};
