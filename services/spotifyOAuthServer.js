const http = require('node:http');
const {
    isWebApiConfigured,
    defaultDeviceName,
    redirectUri,
    markGuildLinkedWithLibrespot,
} = require('./spotifyAuth');
const {
    startHeadlessOAuth,
    completeHeadlessOAuth,
    isLibrespotOAuthPending,
    normalizeLibrespotRedirect,
} = require('./spotifyLibrespotOAuth');

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
 * @param {string} err Spotify ?error= value
 */
function spotifyErrorHelpHtml(err) {
    const base = `<p><strong>Spotify authorization failed:</strong> <code>${err}</code></p>`;

    if (err === 'server_error') {
        return (
            base +
            `<p>Spotify’s login server failed during authorization (your redirect URL is working).</p>
            <p><strong>Most common fix — Development Mode allowlist:</strong></p>
            <ol>
              <li>Open the <a href="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</a>.</li>
              <li>Select the <strong>same app</strong> as <code>SPOTIFY_CLIENT_ID</code> in the bot’s <code>.env</code>.</li>
              <li>Go to <strong>Settings</strong> → <strong>User Management</strong> (or Users and Access).</li>
              <li>Add the <strong>exact email</strong> of the Spotify Premium account used to log in.</li>
              <li>Save, wait a minute, run <code>/spotify link</code> again (incognito helps).</li>
            </ol>
            <p>Also check: app not suspended, correct Client Secret in <code>.env</code>, try again later if Spotify is having an outage.</p>
            <p>If the address bar has <code>code=</code> and <code>state=</code> instead of <code>error=</code>, use <code>/spotify finish</code> in Discord with the full URL.</p>`
        );
    }

    if (err === 'access_denied') {
        return (
            base +
            '<p>You cancelled login or this Spotify account is not allowed for this app (Development Mode allowlist).</p>'
        );
    }

    return base + '<p>Run <code>/spotify link</code> again or use <code>/spotify finish</code> with the browser URL if login succeeded.</p>';
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
    const lines = [
        `Spotify linked for this server. Connect device: **${deviceName}**.`,
        connectError
            ? `Connect device failed to start: ${connectError.message}`
            : isActive(guildId)
              ? 'Device is running — open Spotify → **Connect** and pick it.'
              : 'Device did not stay running; check the bot console.',
        'Use **/joinvc** so playback is heard in Discord.',
    ];

    const discordMessage = lines.join('\n');
    await notifyLinker(client, { userId }, discordMessage);

    return {
        guildId,
        userId,
        deviceName,
        connectError,
        discordMessage,
        htmlBody:
            `<p>Spotify linked. Device: <strong>${deviceName}</strong>.</p>` +
            (connectError
                ? `<p><strong>Error:</strong> ${connectError.message}</p>`
                : isActive(guildId)
                  ? '<p>Open Spotify → Connect and choose this device.</p>'
                  : '<p>Check the bot console.</p>') +
            '<p>You can close this tab and return to Discord.</p>',
    };
}

/**
 * Start librespot headless OAuth for a guild.
 * @param {string} guildId
 * @param {string} userId
 */
async function beginSpotifyLink(guildId, userId) {
    createOAuthState(guildId, userId);
    const url = await startHeadlessOAuth(
        guildId,
        userId,
        defaultDeviceName()
    );
    return url;
}

/**
 * @param {import('discord.js').Client | null} client
 * @param {string} redirectRaw
 * @param {string} [state]
 * @param {{ expectedUserId?: string, guildId?: string }} [opts]
 */
async function finishSpotifyLink(client, redirectRaw, state, opts = {}) {
    let guildId = opts.guildId;
    let userId = opts.expectedUserId;

    if (state) {
        const pending = consumeOAuthState(state);
        if (!pending) {
            throw new Error('Link expired or invalid. Run `/spotify link` again.');
        }
        if (opts.expectedUserId && pending.userId !== opts.expectedUserId) {
            throw new Error(
                'This link was started by someone else. Run `/spotify link` yourself.'
            );
        }
        guildId = pending.guildId;
        userId = pending.userId;
    }

    if (!guildId || !userId) {
        throw new Error('Run `/spotify link` first, then `/spotify finish`.');
    }

    if (!isLibrespotOAuthPending(guildId)) {
        throw new Error(
            'No pending Spotify login for this server. Run `/spotify link` again.'
        );
    }

    await completeHeadlessOAuth(guildId, redirectRaw);
    return completeLibrespotLink(client, guildId, userId);
}

/**
 * Legacy Web API callback path (deprecated for Connect).
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

    throw new Error(
        'This callback used the old Spotify Web API flow, which no longer works with librespot Connect. Run `/spotify link` again and complete login with `/spotify finish` using the `http://127.0.0.1/login?code=...` URL.'
    );
}

/**
 * @param {import('discord.js').Client} client
 */
function startSpotifyOAuthServer(client) {
    if (!isWebApiConfigured()) {
        console.log(
            '[spotify] Web API OAuth env not set; linking uses librespot OAuth via /spotify link.'
        );
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
                console.error(
                    '[spotify] OAuth callback error from Spotify:',
                    err,
                    url.searchParams.get('error_description') || '',
                    req.url
                );
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(spotifyErrorHelpHtml(err));
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
    beginSpotifyLink,
    finishSpotifyLink,
    completeSpotifyLink,
    normalizeLibrespotRedirect,
};
