const {
    isConfigured,
    defaultDeviceName,
    markGuildLinkedWithLibrespot,
} = require('./spotifyAuth');
const {
    startHeadlessOAuth,
    completeHeadlessOAuth,
    isLibrespotOAuthPending,
} = require('./spotifyLibrespotOAuth');

/** @type {Map<string, { guildId: string, userId: string, createdAt: number }>} */
const pendingStates = new Map();

/** @type {import('discord.js').Client | null} */
let discordClient = null;

const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * @param {string} deviceName
 * @param {string} authorizeUrl
 */
function formatSpotifyLinkMessage(deviceName, authorizeUrl) {
    return [
        '**Link Spotify to GrokSlop** (Premium required)',
        '',
        '1. **Click this link** and sign in to Spotify:',
        authorizeUrl,
        '',
        '2. After login, the page will **not load** — **connection refused** or **can’t reach this page** is normal.',
        '3. Copy the **entire URL** from your address bar (`http://127.0.0.1/login?code=...`).',
        '4. Run **`/spotify finish`** in this server and paste that URL into **`redirect`**.',
        '',
        '**Then play in Discord:** run **`/joinvc`**, open Spotify → **Connect to a device** → pick **' +
            deviceName +
            '**.',
    ].join('\n');
}

/**
 * @param {string} deviceName
 */
function getLinkInstructions(deviceName) {
    return formatSpotifyLinkMessage(deviceName, '(run `/spotify link` to get the login URL)');
}

/**
 * @param {string} deviceName
 */
function getConnectInstructions(deviceName) {
    return [
        '**Use Spotify Connect**',
        '1. Run **`/joinvc`** if the bot is not already in your voice channel.',
        '2. In Spotify (phone or desktop), tap **Connect to a device**.',
        `3. Choose **${deviceName}**.`,
        '4. Play a track — audio goes to Discord voice.',
        '',
        'Use the **same Premium account** you linked. One Spotify Connect device per server.',
    ].join('\n');
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function createOAuthState(guildId, userId) {
    const state = `${guildId}.${userId}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    pendingStates.set(state, {
        guildId,
        userId,
        createdAt: Date.now(),
    });
    return state;
}

/**
 * @param {string} state
 */
function getOAuthState(state) {
    const rec = pendingStates.get(state);
    if (!rec) {
        return null;
    }
    if (Date.now() - rec.createdAt > STATE_TTL_MS) {
        pendingStates.delete(state);
        return null;
    }
    return rec;
}

/**
 * @param {string} state
 */
function consumeOAuthState(state) {
    const rec = getOAuthState(state);
    pendingStates.delete(state);
    return rec;
}

function pruneStates() {
    const now = Date.now();
    for (const [key, rec] of pendingStates) {
        if (now - rec.createdAt > STATE_TTL_MS) {
            pendingStates.delete(key);
        }
    }
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function findPendingStateForGuildUser(guildId, userId) {
    for (const [state, rec] of pendingStates) {
        if (
            rec.guildId === guildId &&
            rec.userId === userId &&
            Date.now() - rec.createdAt <= STATE_TTL_MS
        ) {
            return state;
        }
    }
    return null;
}

/**
 * @param {string} raw
 * @returns {{ code: string, state: string }}
 */
function parseRedirectInput(raw) {
    const s = raw.trim();
    if (!s) {
        throw new Error('Paste the full redirect URL from your browser address bar.');
    }

    let url;
    try {
        if (/^https?:\/\//i.test(s)) {
            url = new URL(s);
        } else if (s.includes('code=')) {
            url = new URL(`http://127.0.0.1/login?${s.replace(/^\?/, '')}`);
        } else {
            throw new Error('unrecognized');
        }
    } catch {
        throw new Error(
            'Could not parse that URL. Paste the full address bar after Spotify login (should contain `code=`).'
        );
    }

    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');

    if (err) {
        throw new Error(`Spotify authorization failed: ${err}`);
    }
    if (!code) {
        throw new Error('URL is missing `code=`. Paste the full address bar URL.');
    }

    return { code, state: url.searchParams.get('state') || '' };
}

/**
 * @param {import('discord.js').Client | null} client
 * @param {{ userId: string }} pending
 */
async function notifyLinker(client, pending, content) {
    if (!client) {
        return;
    }
    try {
        const user = await client.users.fetch(pending.userId);
        await user.send(content);
    } catch (e) {
        console.warn('[spotify] could not DM linker:', e?.message || e);
    }
}

/**
 * @param {import('discord.js').Client | null} client
 * @param {string} guildId
 * @param {string} userId
 */
async function completeLibrespotLink(client, guildId, userId) {
    const {
        ensureConnectDevice,
        attachIfLinkedInVoice,
        isActive,
    } = require('./spotifyConnect');

    markGuildLinkedWithLibrespot(guildId, userId);

    let connectError = null;
    try {
        await ensureConnectDevice(guildId);
    } catch (e) {
        connectError = e;
        console.error('[spotify] ensureConnectDevice after link:', e);
    }

    const { getConnectionData } = require('./voiceManager');
    const conn = getConnectionData(guildId);
    if (conn?.player) {
        try {
            await attachIfLinkedInVoice(guildId, conn.player);
        } catch (e) {
            console.error('[spotify] attach voice after link:', e);
        }
    }

    const deviceName = defaultDeviceName();
    const discordMessage = [
        `Spotify linked for this server.`,
        connectError
            ? `Connect device failed to start: ${connectError.message}`
            : isActive(guildId)
              ? `**${deviceName}** is ready in Spotify → **Connect to a device**.`
              : 'Connect device did not stay running — check the bot console and run `/spotify status`.',
        '',
        getConnectInstructions(deviceName),
    ].join('\n');

    await notifyLinker(client, { userId }, discordMessage);

    return {
        guildId,
        userId,
        deviceName,
        connectError,
        discordMessage,
    };
}

/**
 * Start librespot OAuth and return the Spotify authorize URL for Discord.
 * @param {string} guildId
 * @param {string} userId
 */
async function beginSpotifyLink(guildId, userId) {
    createOAuthState(guildId, userId);
    const authorizeUrl = await startHeadlessOAuth(
        guildId,
        userId,
        defaultDeviceName()
    );
    return {
        authorizeUrl,
        deviceName: defaultDeviceName(),
    };
}

/**
 * @param {import('discord.js').Client | null} client
 * @param {string} redirectRaw
 * @param {string} state
 */
async function finishSpotifyLink(client, redirectRaw, state) {
    const pending = getOAuthState(state);
    if (!pending) {
        throw new Error('Link expired or invalid. Run `/spotify link` again.');
    }

    if (!isLibrespotOAuthPending(pending.guildId)) {
        throw new Error(
            'No pending Spotify login for this server. Run `/spotify link` again.'
        );
    }

    await completeHeadlessOAuth(pending.guildId, redirectRaw);
    consumeOAuthState(state);
    return completeLibrespotLink(client, pending.guildId, pending.userId);
}

/**
 * @param {import('discord.js').Client} client
 */
function initSpotifyLink(client) {
    discordClient = client;

    if (!isConfigured()) {
        console.log('[spotify] Set LIBRESPOT_PATH to enable Spotify linking.');
        return;
    }

    setInterval(pruneStates, 60_000).unref?.();
    console.log('[spotify] Discord linking ready (/spotify link → /spotify finish).');
}

module.exports = {
    initSpotifyLink,
    createOAuthState,
    consumeOAuthState,
    getOAuthState,
    findPendingStateForGuildUser,
    parseRedirectInput,
    beginSpotifyLink,
    finishSpotifyLink,
    getLinkInstructions,
    getConnectInstructions,
    formatSpotifyLinkMessage,
};
