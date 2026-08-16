const http = require('node:http');
const {
    isConfigured,
    defaultDeviceName,
    redirectUri,
    markGuildLinkedWithLibrespot,
} = require('./spotifyAuth');
const {
    startHeadlessOAuth,
    completeHeadlessOAuth,
    isLibrespotOAuthPending,
} = require('./spotifyLibrespotOAuth');

/** @type {Map<string, { guildId: string, userId: string, createdAt: number, browseUrl?: string }>} */
const pendingStates = new Map();

/** @type {import('discord.js').Client | null} */
let discordClient = null;

const STATE_TTL_MS = 15 * 60 * 1000;

function getPublicBaseUrl() {
    const explicit = process.env.SPOTIFY_PUBLIC_BASE_URL?.trim();
    if (explicit) {
        return explicit.replace(/\/$/, '');
    }
    try {
        const parsed = new URL(redirectUri());
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        const port = Number(process.env.SPOTIFY_OAUTH_PORT) || 3921;
        return `http://127.0.0.1:${port}`;
    }
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
 * @param {import('http').IncomingMessage} req
 */
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * @param {string} body
 */
function parseFormBody(body) {
    const params = new URLSearchParams(body);
    return {
        state: params.get('state') || '',
        redirect: params.get('redirect') || '',
    };
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {{ browseUrl: string, state: string, error?: string }} opts
 */
function linkPageHtml({ browseUrl, state, error }) {
    const device = escapeHtml(defaultDeviceName());
    const errBlock = error
        ? `<p style="color:#c0392b"><strong>${escapeHtml(error)}</strong></p>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Spotify — GrokSlop</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    a.btn { display: inline-block; background: #1db954; color: #fff; padding: 0.75rem 1.25rem; border-radius: 999px; text-decoration: none; font-weight: 600; }
    textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 0.85rem; }
    button { margin-top: 0.5rem; padding: 0.6rem 1rem; cursor: pointer; }
    .muted { color: #666; font-size: 0.95rem; }
    hr { margin: 2rem 0; border: none; border-top: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>Link Spotify to GrokSlop</h1>
  <p class="muted">Spotify <strong>Premium</strong> required. Device name: <strong>${device}</strong>.</p>
  ${errBlock}
  <p><a class="btn" href="${escapeHtml(browseUrl)}" id="spotify-go">Continue to Spotify</a></p>
  <p class="muted">You will be sent to Spotify to approve access.</p>
  <hr>
  <h2>Finish linking</h2>
  <p>After login, your browser may show <strong>connection refused</strong> or <strong>can't reach this page</strong> — that is normal.</p>
  <p>Copy the <strong>entire URL</strong> from the address bar (<code>http://127.0.0.1/login?code=...</code>) and paste it below:</p>
  <form method="POST" action="/spotify/link">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <textarea name="redirect" rows="4" required placeholder="http://127.0.0.1/login?code=..."></textarea>
    <br>
    <button type="submit">Complete linking</button>
  </form>
  <script>
    setTimeout(function () {
      var a = document.getElementById('spotify-go');
      if (a) { window.location.href = a.href; }
    }, 900);
  </script>
</body>
</html>`;
}

/**
 * @param {{ deviceName: string, connectError?: Error | null }} result
 */
function successPageHtml(result) {
    const device = escapeHtml(result.deviceName);
    const err = result.connectError
        ? `<p><strong>Note:</strong> ${escapeHtml(result.connectError.message)}</p>`
        : '<p>Open Spotify on your phone → <strong>Connect</strong> → choose this device.</p><p>In Discord run <strong>/joinvc</strong> to hear playback.</p>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spotify linked — GrokSlop</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    .ok { color: #1db954; font-size: 1.4rem; }
  </style>
</head>
<body>
  <p class="ok">✓ Spotify linked</p>
  <p>Connect device: <strong>${device}</strong></p>
  ${err}
  <p>You can close this tab and return to Discord. You should also receive a DM from the bot.</p>
</body>
</html>`;
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
            'Could not parse that URL. Paste the full address bar after Spotify login (should contain code=).'
        );
    }

    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');

    if (err) {
        throw new Error(`Spotify authorization failed: ${err}`);
    }
    if (!code) {
        throw new Error('URL is missing code=. Paste the full address bar URL.');
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
        `Spotify linked for this server. Connect device: **${deviceName}**.`,
        connectError
            ? `Connect device failed to start: ${connectError.message}`
            : isActive(guildId)
              ? 'Device is running — open Spotify → **Connect** and pick it.'
              : 'Device did not stay running; check the bot console.',
        'Use **/joinvc** so playback is heard in Discord.',
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
 * Start librespot OAuth and return the public website link URL.
 * @param {string} guildId
 * @param {string} userId
 */
async function beginSpotifyLink(guildId, userId) {
    const state = createOAuthState(guildId, userId);
    const browseUrl = await startHeadlessOAuth(
        guildId,
        userId,
        defaultDeviceName()
    );
    const rec = pendingStates.get(state);
    if (rec) {
        rec.browseUrl = browseUrl;
    }
    return `${getPublicBaseUrl()}/spotify/link?state=${encodeURIComponent(state)}`;
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
function startSpotifyOAuthServer(client) {
    discordClient = client;

    if (!isConfigured()) {
        console.log(
            '[spotify] Set LIBRESPOT_PATH to enable Spotify linking.'
        );
        return;
    }

    const port = Number(process.env.SPOTIFY_OAUTH_PORT) || 3921;
    const publicBase = getPublicBaseUrl();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
            const pathname = url.pathname.replace(/\/$/, '') || '/';

            if (pathname === '/spotify/link') {
                if (req.method === 'GET') {
                    const state = url.searchParams.get('state') || '';
                    const pending = getOAuthState(state);
                    if (!pending?.browseUrl) {
                        res.writeHead(400, {
                            'Content-Type': 'text/html; charset=utf-8',
                        });
                        res.end(
                            '<p>Invalid or expired link. Run <code>/spotify link</code> in Discord again.</p>'
                        );
                        return;
                    }

                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                    });
                    res.end(
                        linkPageHtml({
                            browseUrl: pending.browseUrl,
                            state,
                        })
                    );
                    return;
                }

                if (req.method === 'POST') {
                    const body = await readRequestBody(req);
                    const { state, redirect } = parseFormBody(body);
                    const pending = getOAuthState(state);

                    if (!pending) {
                        res.writeHead(400, {
                            'Content-Type': 'text/html; charset=utf-8',
                        });
                        res.end(
                            linkPageHtml({
                                browseUrl: '#',
                                state: state || '',
                                error: 'Link expired. Run /spotify link in Discord again.',
                            })
                        );
                        return;
                    }

                    try {
                        parseRedirectInput(redirect);
                        const result = await finishSpotifyLink(
                            discordClient,
                            redirect,
                            state
                        );
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf-8',
                        });
                        res.end(successPageHtml(result));
                    } catch (e) {
                        res.writeHead(400, {
                            'Content-Type': 'text/html; charset=utf-8',
                        });
                        res.end(
                            linkPageHtml({
                                browseUrl: pending.browseUrl || '#',
                                state,
                                error: e.message || String(e),
                            })
                        );
                    }
                    return;
                }
            }

            if (pathname === '/spotify/callback') {
                res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(
                    '<p>This callback path is deprecated for Connect.</p>' +
                        '<p>Run <code>/spotify link</code> in Discord and use the new link page.</p>'
                );
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        } catch (e) {
            console.error('[spotify] HTTP error:', e);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<p>${escapeHtml(e.message || 'Server error')}</p>`);
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(
            `[spotify] Link page listening on port ${port} (${publicBase}/spotify/link)`
        );
    });

    setInterval(pruneStates, 60_000).unref?.();
}

module.exports = {
    startSpotifyOAuthServer,
    createOAuthState,
    consumeOAuthState,
    getOAuthState,
    findPendingStateForGuildUser,
    parseRedirectInput,
    beginSpotifyLink,
    finishSpotifyLink,
    getPublicBaseUrl,
};
