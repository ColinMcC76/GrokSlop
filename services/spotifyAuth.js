const db = require('../storage/db');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-email',
    'user-read-private',
    'streaming',
].join(' ');

const upsertGuildSpotify = db.prepare(`
    INSERT INTO guild_spotify (
        guild_id, access_token, refresh_token, expires_at, device_name, linked_by, updated_at
    ) VALUES (
        @guildId, @accessToken, @refreshToken, @expiresAt, @deviceName, @linkedBy, @updatedAt
    )
    ON CONFLICT(guild_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        device_name = excluded.device_name,
        linked_by = excluded.linked_by,
        updated_at = excluded.updated_at
`);

const selectGuildSpotify = db.prepare(`
    SELECT * FROM guild_spotify WHERE guild_id = ?
`);

const deleteGuildSpotify = db.prepare(`
    DELETE FROM guild_spotify WHERE guild_id = ?
`);

function clientId() {
    const id = process.env.SPOTIFY_CLIENT_ID?.trim();
    if (!id) {
        throw new Error('SPOTIFY_CLIENT_ID is not set in the environment.');
    }
    return id;
}

function clientSecret() {
    const s = process.env.SPOTIFY_CLIENT_SECRET?.trim();
    if (!s) {
        throw new Error('SPOTIFY_CLIENT_SECRET is not set in the environment.');
    }
    return s;
}

function redirectUri() {
    const u = process.env.SPOTIFY_REDIRECT_URI?.trim();
    if (!u) {
        throw new Error('SPOTIFY_REDIRECT_URI is not set (e.g. http://127.0.0.1:3921/spotify/callback).');
    }
    return u;
}

function defaultDeviceName() {
    return process.env.SPOTIFY_DEVICE_NAME?.trim() || 'GrokSlop';
}

/**
 * @param {string} state
 * @param {string} guildId
 * @param {string} userId
 */
function buildAuthorizeUrl(state, guildId, userId) {
    const params = new URLSearchParams({
        client_id: clientId(),
        response_type: 'code',
        redirect_uri: redirectUri(),
        scope: SCOPES,
        state,
        show_dialog: 'true',
    });
    return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * @param {string} code
 */
async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
    });

    const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`,
        },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Spotify token exchange failed: ${errText.slice(0, 300)}`);
    }

    return res.json();
}

/**
 * @param {string} refreshToken
 */
async function refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });

    const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`,
        },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Spotify token refresh failed: ${errText.slice(0, 300)}`);
    }

    return res.json();
}

/**
 * @param {string} guildId
 * @param {string} linkedByUserId
 * @param {{ access_token: string, refresh_token?: string, expires_in: number }} tokens
 */
function saveGuildTokens(guildId, linkedByUserId, tokens) {
    const existing = selectGuildSpotify.get(guildId);
    const refreshToken = tokens.refresh_token || existing?.refresh_token;
    if (!refreshToken) {
        throw new Error('Spotify did not return a refresh token.');
    }

    const expiresAt = Date.now() + tokens.expires_in * 1000;
    upsertGuildSpotify.run({
        guildId,
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt,
        deviceName: existing?.device_name || defaultDeviceName(),
        linkedBy: linkedByUserId,
        updatedAt: Date.now(),
    });
}

/**
 * @param {string} guildId
 * @returns {Promise<string>}
 */
async function getValidAccessToken(guildId) {
    const row = selectGuildSpotify.get(guildId);
    if (!row) {
        throw new Error('This server has not linked Spotify yet.');
    }

    const bufferMs = 5 * 60 * 1000;
    if (row.expires_at > Date.now() + bufferMs) {
        return row.access_token;
    }

    const tokens = await refreshAccessToken(row.refresh_token);
    saveGuildTokens(guildId, row.linked_by, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
    });
    return tokens.access_token;
}

/**
 * @param {string} guildId
 */
function getGuildSpotifyRow(guildId) {
    return selectGuildSpotify.get(guildId) || null;
}

/**
 * @param {string} guildId
 */
function removeGuildSpotify(guildId) {
    deleteGuildSpotify.run(guildId);
}

function isConfigured() {
    return Boolean(
        process.env.SPOTIFY_CLIENT_ID?.trim() &&
            process.env.SPOTIFY_CLIENT_SECRET?.trim() &&
            process.env.SPOTIFY_REDIRECT_URI?.trim()
    );
}

module.exports = {
    buildAuthorizeUrl,
    exchangeCodeForTokens,
    saveGuildTokens,
    getValidAccessToken,
    getGuildSpotifyRow,
    removeGuildSpotify,
    isConfigured,
    defaultDeviceName,
};
