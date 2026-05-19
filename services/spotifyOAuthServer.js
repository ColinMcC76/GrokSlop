const http = require('node:http');
const {
    exchangeCodeForTokens,
    saveGuildTokens,
    isConfigured,
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
 * @param {import('discord.js').Client} client
 */
function startSpotifyOAuthServer(client) {
    if (!isConfigured()) {
        console.log('[spotify] OAuth env not set; /spotify link disabled.');
        return;
    }

    const port = Number(process.env.SPOTIFY_OAUTH_PORT) || 3921;

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

            const pending = consumeOAuthState(state);
            if (!pending) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<p>Link expired or invalid. Run /spotify link again.</p>');
                return;
            }

            const tokens = await exchangeCodeForTokens(code);
            saveGuildTokens(pending.guildId, pending.userId, tokens);

            const { getConnectionData } = require('./voiceManager');
            const {
                ensureConnectDevice,
                attachIfLinkedInVoice,
                isActive,
                getDiagnostics,
            } = require('./spotifyConnect');
            const { defaultDeviceName } = require('./spotifyAuth');

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
            const diag = getDiagnostics(pending.guildId);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<p>Spotify linked for this server. Connect device: <strong>${deviceName}</strong>.</p>` +
                    (connectError
                        ? `<p><strong>Connect device failed to start:</strong> ${connectError.message}</p>`
                        : isActive(pending.guildId)
                          ? '<p>Connect device is running — open Spotify → Connect and pick it.</p>'
                          : '<p>Connect device did not stay running. Check the bot console.</p>') +
                    (diag.lastLog && connectError
                        ? `<p><small>${diag.lastLog}</small></p>`
                        : '') +
                    `<p>Use <strong>/joinvc</strong> so playback is heard in Discord.</p>`
            );

            try {
                const guild = await client.guilds.fetch(pending.guildId);
                const channelId = process.env.SPOTIFY_NOTIFY_CHANNEL_ID;
                if (channelId) {
                    const ch = await guild.channels.fetch(channelId);
                    if (ch?.isTextBased()) {
                        await ch.send(
                            `Spotify linked. Device **${deviceName}** is ready — use it from the Spotify app when the bot is in voice.`
                        );
                    }
                }
            } catch {
                /* optional notify */
            }
        } catch (e) {
            console.error('[spotify] callback error:', e);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<p>Server error linking Spotify.</p>');
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[spotify] OAuth callback listening on port ${port}`);
    });

    setInterval(pruneStates, 60_000).unref?.();
}

module.exports = {
    startSpotifyOAuthServer,
    createOAuthState,
    consumeOAuthState,
};
