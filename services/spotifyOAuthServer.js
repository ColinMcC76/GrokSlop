const http = require('node:http');
const {
    exchangeCodeForTokens,
    saveGuildTokens,
    isConfigured,
    defaultDeviceName,
    redirectUri,
} = require('./spotifyAuth');

/** @type {Map<string, { guildId: string, userId: string, createdAt: number }>} */
const pendingStates = new Map();

const STATE_TTL_MS = 15 * 60 * 1000;

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
function consumeOAuthState(state) {
    const rec = pendingStates.get(state);
    pendingStates.delete(state);
    if (!rec) {
        return null;
    }
    if (Date.now() - rec.createdAt > STATE_TTL_MS) {
        return null;
    }
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
        } else if (s.startsWith('?')) {
            url = new URL(`${redirectUri()}${s}`);
        } else if (s.includes('code=') && s.includes('state=')) {
            const qs = s.startsWith('?') ? s.slice(1) : s;
            url = new URL(`${redirectUri()}?${qs}`);
        } else {
            throw new Error('unrecognized');
        }
    } catch {
        throw new Error(
            'Could not parse that URL. After Spotify login, copy the **entire** address bar (it should contain `code=` and `state=`).'
        );
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');

    if (err) {
        throw new Error(`Spotify authorization failed: ${err}`);
    }
    if (!code || !state) {
        throw new Error('URL is missing `code` or `state`. Run `/spotify link` again and use the new link.');
    }

    return { code, state };
}

/**
 * @param {import('discord.js').Client | null} client
 * @param {{ guildId: string, userId: string }} pending
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
 * @param {string} code
 * @param {string} state
 * @param {{ expectedUserId?: string }} [opts]
 */
async function completeSpotifyLink(client, code, state, opts = {}) {
    const pending = consumeOAuthState(state);
    if (!pending) {
        throw new Error('Link expired or invalid. Run `/spotify link` again.');
    }

    if (opts.expectedUserId && pending.userId !== opts.expectedUserId) {
        throw new Error('This link was started by someone else. Run `/spotify link` yourself.');
    }

    const tokens = await exchangeCodeForTokens(code);
    saveGuildTokens(pending.guildId, pending.userId, tokens);

    const { getConnectionData } = require('./voiceManager');
    const {
        ensureConnectDevice,
        attachIfLinkedInVoice,
        isActive,
    } = require('./spotifyConnect');

    let connectError = null;
    try {
        await ensureConnectDevice(pending.guildId);
    } catch (e) {
        connectError = e;
        console.error('[spotify] ensureConnectDevice after link:', e);
    }

    const conn = getConnectionData(pending.guildId);
    if (conn?.player) {
        try {
            await attachIfLinkedInVoice(pending.guildId, conn.player);
        } catch (e) {
            console.error('[spotify] attach voice after link:', e);
        }
    }

    const deviceName = defaultDeviceName();
    const lines = [
        `Spotify linked for this server. Connect device: **${deviceName}**.`,
        connectError
            ? `Connect device failed to start: ${connectError.message}`
            : isActive(pending.guildId)
              ? 'Device is running — open Spotify → **Connect** and pick it.'
              : 'Device did not stay running; check the bot console.',
        'Use **/joinvc** so playback is heard in Discord.',
    ];

    const discordMessage = lines.join('\n');

    await notifyLinker(client, pending, discordMessage);

    try {
        if (client && process.env.SPOTIFY_NOTIFY_CHANNEL_ID) {
            const guild = await client.guilds.fetch(pending.guildId);
            const ch = await guild.channels.fetch(process.env.SPOTIFY_NOTIFY_CHANNEL_ID);
            if (ch?.isTextBased()) {
                await ch.send(
                    `<@${pending.userId}> linked Spotify. Device **${deviceName}** is ready.`
                );
            }
        }
    } catch {
        /* optional */
    }

    return {
        pending,
        deviceName,
        connectError,
        discordMessage,
        htmlBody:
            `<p>Spotify linked. Device: <strong>${deviceName}</strong>.</p>` +
            (connectError
                ? `<p><strong>Error:</strong> ${connectError.message}</p>`
                : isActive(pending.guildId)
                  ? '<p>Open Spotify → Connect and choose this device.</p>'
                  : '<p>Check the bot console.</p>') +
            '<p>You can close this tab and return to Discord.</p>',
    };
}

/**
 * @param {import('discord.js').Client} client
 */
function startSpotifyOAuthServer(client) {
    if (!isConfigured()) {
        console.log('[spotify] OAuth env not set; /spotify link disabled.');
        return;
    }

    const port = Number(process.env.SPOTIFY_OAUTH_PORT) || 3921;
    const configuredRedirect = redirectUri();
    const isLocalRedirect = /localhost|127\.0\.0\.1/i.test(configuredRedirect);

    if (isLocalRedirect) {
        console.log(
            '[spotify] SPOTIFY_REDIRECT_URI is local-only. Remote users should use `/spotify finish` with the browser URL after login, or use a public HTTPS redirect (see docs/spotify-oauth.md).'
        );
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

            if (url.pathname !== '/spotify/callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const err = url.searchParams.get('error');
            if (err) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<p>Spotify authorization failed: ${err}</p>`);
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            if (!code || !state) {
                res.writeHead(400);
                res.end('Missing code or state');
                return;
            }

            const result = await completeSpotifyLink(client, code, state);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(result.htmlBody);
        } catch (e) {
            console.error('[spotify] callback error:', e);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<p>${e.message || 'Server error linking Spotify.'}</p><p>Try \`/spotify finish\` in Discord with the browser URL.</p>`
            );
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(
            `[spotify] OAuth callback listening on port ${port} (redirect: ${configuredRedirect})`
        );
    });

    setInterval(pruneStates, 60_000).unref?.();
}

module.exports = {
    startSpotifyOAuthServer,
    createOAuthState,
    consumeOAuthState,
    parseRedirectInput,
    completeSpotifyLink,
};
