const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { spawn } = require('node:child_process');

const config = require('../config');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const MAX_LOG_LINES = 400;
const MAX_BODY_BYTES = 100_000;
const TEXT_CHANNEL_TYPES = new Set([0, 5]);
const VOICE_CHANNEL_TYPES = new Set([2, 13]);

/** @type {{ level: string, text: string }[]} */
const logLines = [];
/** @type {Set<import('node:http').ServerResponse>} */
const logClients = new Set();

const HOOKED = Symbol.for('grokslop.dashboard.log');

function formatLogLine(level, text) {
    const stamp = new Date().toLocaleTimeString();
    const tag = level === 'log' || level === 'info' ? '' : `${level.toUpperCase()} `;
    return `${stamp}  ${tag}${text}`;
}

function pushLog(level, text) {
    const line = { level, text: formatLogLine(level, text) };
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) {
        logLines.splice(0, logLines.length - MAX_LOG_LINES);
    }
    const payload = `data: ${JSON.stringify({ type: 'line', ...line })}\n\n`;
    for (const res of logClients) {
        try {
            res.write(payload);
        } catch {
            logClients.delete(res);
        }
    }
}

function hookConsole() {
    if (console[HOOKED]) {
        return;
    }
    console[HOOKED] = true;
    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            try {
                pushLog(level, util.format(...args));
            } catch {
                /* logging must not throw */
            }
        };
    }
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function sendFile(res, spec) {
    const filePath = path.join(PUBLIC_DIR, spec.file);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': spec.type,
            'Cache-Control': 'no-store',
            'Content-Length': data.length,
        });
        res.end(data);
    });
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                const err = new Error('Request is too large.');
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size === 0) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    const err = new Error('Expected a JSON object.');
                    err.statusCode = 400;
                    reject(err);
                    return;
                }
                resolve(parsed);
            } catch {
                const err = new Error('Expected JSON.');
                err.statusCode = 400;
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function clientReady(client) {
    return Boolean(client && typeof client.isReady === 'function' && client.isReady());
}

function channelLabel(channel) {
    if (!channel) {
        return null;
    }
    return channel.name || channel.id;
}

/**
 * @param {import('discord.js').Guild} guild
 */
function listChannels(guild, types) {
    const rows = [];
    for (const channel of guild.channels.cache.values()) {
        if (!types.has(channel.type)) {
            continue;
        }
        rows.push({ id: channel.id, name: channel.name });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

/**
 * @param {import('discord.js').Guild} guild
 */
function listMembers(guild) {
    /** @type {Map<string, { id: string, name: string, voiceChannelId: string | null, voiceChannelName: string | null }>} */
    const members = new Map();

    for (const state of guild.voiceStates.cache.values()) {
        const member = state.member;
        if (!member || member.user?.bot) {
            continue;
        }
        const voice = state.channelId
            ? guild.channels.cache.get(state.channelId)
            : null;
        members.set(member.id, {
            id: member.id,
            name: member.displayName || member.user.username,
            voiceChannelId: state.channelId || null,
            voiceChannelName: voice ? channelLabel(voice) : null,
        });
    }

    for (const member of guild.members.cache.values()) {
        if (member.user?.bot || members.has(member.id)) {
            continue;
        }
        if (members.size >= 300) {
            break;
        }
        members.set(member.id, {
            id: member.id,
            name: member.displayName || member.user.username,
            voiceChannelId: null,
            voiceChannelName: null,
        });
    }

    return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 */
function guildSnapshot(client, guild) {
    const { getConnectionData } = require('../services/voiceManager');
    const { getQueueSnapshot, getYoutubeVolume } = require('../services/youtubeQueue');
    const { isRealtimeActive } = require('../services/realtimeVoiceBridge');
    const {
        isLinked,
        isActive,
        getConnectMode,
        getDiagnostics,
    } = require('../services/spotifyConnect');
    const { getActivePersonaName } = require('../ai/guildPersonas');

    const connection = getConnectionData(guild.id);
    const voiceChannelId = connection?.connection?.joinConfig?.channelId || null;
    const voiceChannel = voiceChannelId
        ? guild.channels.cache.get(voiceChannelId)
        : null;
    const queue = getQueueSnapshot(guild.id);

    let spotify = {
        linked: false,
        active: false,
        mode: null,
        deviceName: null,
    };
    try {
        const diag = getDiagnostics(guild.id);
        spotify = {
            linked: isLinked(guild.id),
            active: isActive(guild.id),
            mode: getConnectMode(guild.id),
            deviceName: diag.deviceName || null,
        };
    } catch (err) {
        console.warn('[dashboard] spotify status failed:', err?.message || err);
    }

    let persona = null;
    try {
        persona = getActivePersonaName(guild.id);
    } catch (err) {
        console.warn('[dashboard] persona status failed:', err?.message || err);
    }

    return {
        id: guild.id,
        name: guild.name,
        textChannels: listChannels(guild, TEXT_CHANNEL_TYPES),
        voiceChannels: listChannels(guild, VOICE_CHANNEL_TYPES),
        members: listMembers(guild),
        voice: voiceChannelId
            ? {
                  channelId: voiceChannelId,
                  channelName: channelLabel(voiceChannel) || voiceChannelId,
              }
            : null,
        nowPlaying: queue.current
            ? {
                  title: queue.current.title || 'YouTube',
                  url: queue.current.url || '',
              }
            : null,
        queueCount: queue.total,
        realtime: isRealtimeActive(guild.id),
        spotify,
        persona,
        volume: getYoutubeVolume(guild.id),
    };
}

/**
 * @param {import('discord.js').Client} client
 */
function buildStatus(client) {
    const ready = clientReady(client);
    const status = {
        ok: true,
        ready,
        botName: config.botName,
        tag: ready && client.user ? client.user.tag : null,
        ping: ready ? client.ws.ping : null,
        guilds: [],
    };
    if (!ready) {
        return status;
    }
    for (const guild of client.guilds.cache.values()) {
        try {
            status.guilds.push(guildSnapshot(client, guild));
        } catch (err) {
            console.warn(
                `[dashboard] status for ${guild.id} failed:`,
                err?.message || err
            );
        }
    }
    status.guilds.sort((a, b) => a.name.localeCompare(b.name));
    return status;
}

function openAppWindow(url) {
    if (process.env.DASHBOARD_OPEN === '0') {
        return;
    }

    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const candidates = [
            path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
        const exe = candidates.find((candidate) => candidate && fs.existsSync(candidate));
        if (exe) {
            const child = spawn(
                exe,
                [`--app=${url}`, '--new-window', '--window-size=1120,820'],
                { detached: true, stdio: 'ignore', windowsHide: true }
            );
            child.on('error', (err) => {
                console.error('[dashboard] could not open app window:', err.message || err);
            });
            child.unref();
            return;
        }
        const fallback = spawn('cmd', ['/c', 'start', '', url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        fallback.on('error', (err) => {
            console.error('[dashboard] could not open browser:', err.message || err);
        });
        fallback.unref();
        return;
    }

    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
}

/**
 * @param {import('discord.js').Client} client
 */
function startDashboard(client) {
    hookConsole();

    const port = Number(process.env.DASHBOARD_PORT) || 3847;
    const host = '127.0.0.1';

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${host}`);
            const pathname = url.pathname;

            if (req.method === 'GET' && PUBLIC_FILES[pathname]) {
                sendFile(res, PUBLIC_FILES[pathname]);
                return;
            }

            if (req.method === 'GET' && pathname === '/api/status') {
                sendJson(res, 200, buildStatus(client));
                return;
            }

            if (req.method === 'GET' && pathname === '/api/logs') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-store',
                    Connection: 'keep-alive',
                });
                res.write(
                    `data: ${JSON.stringify({ type: 'snapshot', lines: logLines })}\n\n`
                );
                logClients.add(res);
                const heartbeat = setInterval(() => {
                    res.write(': ping\n\n');
                }, 15000);
                req.on('close', () => {
                    clearInterval(heartbeat);
                    logClients.delete(res);
                });
                return;
            }

            if (req.method === 'POST' && pathname === '/api/action') {
                const body = await readBody(req);
                if (!clientReady(client)) {
                    sendJson(res, 503, {
                        ok: false,
                        message: 'GrokSlop is not online yet.',
                    });
                    return;
                }
                const { runAction } = require('./actions');
                const result = await runAction(client, body);
                sendJson(res, 200, result);
                return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
        } catch (err) {
            const status = err.statusCode || 500;
            if (status >= 500) {
                console.error('[dashboard] request failed:', err?.message || err);
            }
            if (!res.headersSent) {
                sendJson(res, status, {
                    ok: false,
                    message: err?.message || String(err),
                });
            } else {
                res.end();
            }
        }
    });

    server.listen(port, host, () => {
        const url = `http://${host}:${port}`;
        console.log(`[dashboard] control panel at ${url}`);
        openAppWindow(url);
    });

    server.on('error', (err) => {
        console.error('[dashboard] server failed:', err?.message || err);
    });

    return { server, port, host };
}

module.exports = {
    startDashboard,
};
