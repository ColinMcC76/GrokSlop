const crypto = require('node:crypto');

const accessStore = require('./accessStore');

const SESSION_COOKIE = 'gs_session';
const STATE_COOKIE = 'gs_state';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const PUBLIC_HOSTS = new Set(['whorezone.party', 'www.whorezone.party']);

/** @type {Map<string, { count: number, reset: number }>} */
const attempts = new Map();

function sessionSecret() {
    return String(process.env.DASHBOARD_SESSION_SECRET || '').trim();
}

function clientId() {
    return String(process.env.CLIENT_ID || '').trim();
}

function clientSecret() {
    return String(process.env.DISCORD_CLIENT_SECRET || '').trim();
}

function ownerId() {
    return String(process.env.DASHBOARD_OWNER_ID || '').trim();
}

function isConfigured() {
    return Boolean(
        clientId() &&
            clientSecret() &&
            accessStore.isSnowflake(ownerId()) &&
            sessionSecret().length >= 16
    );
}

function isOwner(id) {
    return Boolean(id) && id === ownerId();
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function hostFromHeaderValue(value) {
    const raw = String(value || '').split(',')[0].trim();
    if (!raw) {
        return '';
    }
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        return (end > 0 ? raw.slice(1, end) : raw).toLowerCase();
    }
    return raw.split(':')[0].toLowerCase();
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function hostnameOf(req) {
    return hostFromHeaderValue(req.headers.host);
}

/**
 * Cloudflare Tunnel reaches this process on loopback, sometimes with a
 * loopback Host header. Those requests are still the public site.
 * @param {import('node:http').IncomingMessage} req
 */
function isTunnelRequest(req) {
    const host = hostnameOf(req);
    if (host && !isLoopbackHost(host)) {
        return true;
    }
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-visitor']) {
        return true;
    }
    const forwarded = hostFromHeaderValue(req.headers['x-forwarded-host']);
    if (forwarded && !isLoopbackHost(forwarded)) {
        return true;
    }
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function requestHostname(req) {
    const forwarded = hostFromHeaderValue(req.headers['x-forwarded-host']);
    if (forwarded && !isLoopbackHost(forwarded)) {
        return forwarded;
    }
    const host = hostnameOf(req);
    if (host && !isLoopbackHost(host)) {
        return host;
    }
    if (isTunnelRequest(req)) {
        return 'whorezone.party';
    }
    return host;
}

function isLoopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isAllowedHost(hostname) {
    return isLoopbackHost(hostname) || PUBLIC_HOSTS.has(hostname);
}

/**
 * Public hostnames are served over HTTPS by Cloudflare.
 * The local panel is plain HTTP on loopback.
 * @param {import('node:http').IncomingMessage} req
 */
function externalOrigin(req) {
    const hostname = requestHostname(req);
    if (PUBLIC_HOSTS.has(hostname)) {
        return `https://${hostname}`;
    }
    const raw = String(req.headers.host || '').split(',')[0].trim();
    let portPart = '';
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        portPart = end >= 0 ? raw.slice(end + 1) : '';
    } else {
        const colon = raw.lastIndexOf(':');
        portPart = colon > 0 ? raw.slice(colon) : '';
    }
    const port = /^:\d{1,5}$/.test(portPart) ? portPart : '';
    const host = hostname === '::1' ? '[::1]' : hostname;
    return `http://${host}${port}`;
}

function secureRequest(req) {
    return PUBLIC_HOSTS.has(requestHostname(req));
}

function clientIp(req) {
    const header = req.headers['cf-connecting-ip'];
    if (typeof header === 'string' && header.trim()) {
        return header.trim();
    }
    return req.socket?.remoteAddress || 'local';
}

function limited(req, bucket) {
    const key = `${bucket}:${clientIp(req)}`;
    const now = Date.now();
    const row = attempts.get(key);
    if (attempts.size > 500) {
        for (const [attemptKey, attempt] of attempts) {
            if (attempt.reset <= now) {
                attempts.delete(attemptKey);
            }
        }
    }
    if (!row || row.reset <= now) {
        attempts.set(key, { count: 1, reset: now + 10 * 60 * 1000 });
        return false;
    }
    row.count += 1;
    return row.count > 20;
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
    return `${body}.${mac}`;
}

function readSigned(token) {
    if (!isConfigured() || typeof token !== 'string' || token.length > 4000) {
        return null;
    }
    const dot = token.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
    if (!safeEqual(mac, expected)) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return null;
        }
        if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header || typeof header !== 'string') {
        return '';
    }
    for (const part of header.split(';')) {
        const text = part.trim();
        const eq = text.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        if (text.slice(0, eq) !== name) {
            continue;
        }
        try {
            return decodeURIComponent(text.slice(eq + 1));
        } catch {
            return '';
        }
    }
    return '';
}

function cookiePair(name, value, { maxAge, secure }) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (typeof maxAge === 'number') {
        parts.push(`Max-Age=${maxAge}`);
    }
    if (secure) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

function clearCookie(name, secure) {
    return cookiePair(name, '', { maxAge: 0, secure });
}

/**
 * @param {{ id: string, username?: string }} user
 * @param {number} [exp]
 */
function createSessionToken(user, exp = Date.now() + SESSION_MS) {
    return sign({
        id: String(user.id),
        username: accessStore.cleanName(user.username) || String(user.id),
        exp,
    });
}

function readSession(req) {
    const payload = readSigned(readCookie(req, SESSION_COOKIE));
    if (!payload || !accessStore.isSnowflake(payload.id)) {
        return null;
    }
    return {
        id: String(payload.id),
        username: accessStore.cleanName(payload.username) || String(payload.id),
    };
}

/**
 * @param {{ id: string, username?: string } | null} session
 */
function roleOf(session) {
    if (!session) {
        return 'anonymous';
    }
    if (isOwner(session.id) || accessStore.isApproved(session.id)) {
        return 'allowed';
    }
    if (accessStore.isPending(session.id)) {
        return 'pending';
    }
    return 'anonymous';
}

function viewerFrom(session) {
    return {
        id: session.id,
        username: session.username,
        owner: isOwner(session.id),
    };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} pathname
 */
function authorizeRequest(req, pathname) {
    const hostname = requestHostname(req);
    const configured = isConfigured();
    const localOpen = !configured && isLoopbackHost(hostnameOf(req)) && !isTunnelRequest(req);

    if (!configured) {
        if (localOpen) {
            if (pathname === '/login' || pathname === '/waiting' || pathname === '/admin') {
                return { handled: true, status: 302, location: '/' };
            }
            return { handled: false, viewer: null };
        }
        if (req.method === 'GET' && pathname === '/style.css') {
            return { handled: false, viewer: null };
        }
        if (req.method === 'GET' && (pathname === '/' || pathname === '/login' || pathname === '/index.html')) {
            return { handled: false, page: 'login' };
        }
        if (pathname.startsWith('/api/')) {
            return { handled: true, status: 401, json: { ok: false, message: 'Sign in required.' } };
        }
        return { handled: true, status: 302, location: '/login' };
    }

    if (!isAllowedHost(hostname)) {
        return {
            handled: true,
            status: 403,
            text: 'This address is not allowed to open the panel.',
        };
    }

    if (req.method === 'GET' && pathname === '/style.css') {
        return { handled: false, viewer: null };
    }

    const session = readSession(req);
    const role = roleOf(session);

    if (pathname === '/login') {
        if (req.method !== 'GET') {
            return { handled: true, status: 404, text: 'Not found' };
        }
        if (role === 'allowed') {
            return { handled: true, status: 302, location: '/' };
        }
        if (role === 'pending') {
            return { handled: true, status: 302, location: '/waiting' };
        }
        return { handled: false, page: 'login' };
    }

    if (pathname === '/waiting') {
        if (req.method !== 'GET') {
            return { handled: true, status: 404, text: 'Not found' };
        }
        if (role === 'allowed') {
            return { handled: true, status: 302, location: '/' };
        }
        if (role !== 'pending') {
            return { handled: true, status: 302, location: '/login' };
        }
        return { handled: false, page: 'waiting' };
    }

    if (pathname === '/api/me') {
        if (req.method !== 'GET') {
            return { handled: true, status: 404, text: 'Not found' };
        }
        if (role === 'pending') {
            return {
                handled: true,
                status: 200,
                json: {
                    ok: true,
                    status: 'pending',
                    id: session.id,
                    username: session.username,
                },
            };
        }
        if (role !== 'allowed') {
            return { handled: true, status: 401, json: { ok: false, message: 'Sign in required.' } };
        }
        return {
            handled: true,
            status: 200,
            json: {
                ok: true,
                status: 'allowed',
                id: session.id,
                username: session.username,
                owner: isOwner(session.id),
            },
        };
    }

    if (role === 'anonymous') {
        if (pathname.startsWith('/api/')) {
            return { handled: true, status: 401, json: { ok: false, message: 'Sign in required.' } };
        }
        return { handled: true, status: 302, location: '/login' };
    }

    if (role === 'pending') {
        if (pathname.startsWith('/api/')) {
            return {
                handled: true,
                status: 403,
                json: { ok: false, pending: true, message: 'Waiting for approval.' },
            };
        }
        return { handled: true, status: 302, location: '/waiting' };
    }

    const viewer = viewerFrom(session);
    if (pathname === '/admin') {
        if (req.method !== 'GET') {
            return { handled: true, status: 404, text: 'Not found' };
        }
        if (!viewer.owner) {
            return { handled: true, status: 302, location: '/' };
        }
        return { handled: false, page: 'admin', viewer };
    }

    return { handled: false, viewer };
}

function redirectUri(req) {
    return `${externalOrigin(req)}/auth/discord/callback`;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {URL} url
 * @param {{ redirect: Function, sendText: Function }} http
 */
async function handleAuthRoutes(req, res, pathname, url, http) {
    if (req.method !== 'GET') {
        return false;
    }
    if (pathname !== '/auth/discord' && pathname !== '/auth/discord/callback' && pathname !== '/logout') {
        return false;
    }

    const hostname = requestHostname(req);
    const localOpen = !isConfigured() && isLoopbackHost(hostnameOf(req)) && !isTunnelRequest(req);
    if (isConfigured() && !isAllowedHost(hostname)) {
        http.sendText(res, 403, 'This address is not allowed to open the panel.');
        return true;
    }
    if (!isConfigured() && !localOpen && !isTunnelRequest(req) && !isLoopbackHost(hostnameOf(req))) {
        http.sendText(
            res,
            403,
            'Discord login is not configured. The panel stays on this computer until it is.'
        );
        return true;
    }

    if (pathname === '/logout') {
        const secure = secureRequest(req);
        http.redirect(res, localOpen ? '/' : '/login', [
            clearCookie(SESSION_COOKIE, secure),
            clearCookie(STATE_COOKIE, secure),
        ]);
        return true;
    }

    if (!isConfigured()) {
        http.redirect(res, '/login?error=setup');
        return true;
    }

    if (pathname === '/auth/discord') {
        if (limited(req, 'start')) {
            http.sendText(res, 429, 'Too many sign-in attempts. Wait a few minutes.');
            return true;
        }
        const nonce = crypto.randomBytes(24).toString('base64url');
        const origin = externalOrigin(req);
        const state = sign({ nonce, origin, exp: Date.now() + STATE_MS });
        const authorize = new URL('https://discord.com/oauth2/authorize');
        authorize.searchParams.set('client_id', clientId());
        authorize.searchParams.set('response_type', 'code');
        authorize.searchParams.set('redirect_uri', redirectUri(req));
        authorize.searchParams.set('scope', 'identify');
        authorize.searchParams.set('state', nonce);
        http.redirect(res, authorize.toString(), [
            cookiePair(STATE_COOKIE, state, { maxAge: Math.floor(STATE_MS / 1000), secure: secureRequest(req) }),
        ]);
        return true;
    }

    if (limited(req, 'callback')) {
        http.sendText(res, 429, 'Too many sign-in attempts. Wait a few minutes.');
        return true;
    }
    if (url.searchParams.get('error')) {
        http.redirect(res, '/login?error=denied', [clearCookie(STATE_COOKIE, secureRequest(req))]);
        return true;
    }

    const code = url.searchParams.get('code') || '';
    const nonce = url.searchParams.get('state') || '';
    const state = readSigned(readCookie(req, STATE_COOKIE));
    const origin = externalOrigin(req);
    if (
        !code ||
        !state ||
        typeof state.nonce !== 'string' ||
        state.origin !== origin ||
        !safeEqual(state.nonce, nonce)
    ) {
        http.redirect(res, '/login?error=failed', [clearCookie(STATE_COOKIE, secureRequest(req))]);
        return true;
    }

    try {
        const user = await fetchDiscordUser(code, redirectUri(req));
        const secure = secureRequest(req);
        const cookies = [
            clearCookie(STATE_COOKIE, secure),
            cookiePair(SESSION_COOKIE, createSessionToken({
                id: user.id,
                username: user.globalName || user.username,
            }), {
                maxAge: Math.floor(SESSION_MS / 1000),
                secure,
            }),
        ];
        if (isOwner(user.id) || accessStore.isApproved(user.id)) {
            http.redirect(res, '/', cookies);
            return true;
        }
        accessStore.rememberPending(user);
        http.redirect(res, '/waiting', cookies);
        return true;
    } catch (err) {
        console.warn('[dashboard] Discord sign-in failed:', err?.message || err);
        http.redirect(res, '/login?error=failed', [clearCookie(STATE_COOKIE, secureRequest(req))]);
        return true;
    }
}

async function fetchDiscordUser(code, redirect) {
    const body = new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
    });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'GrokSlop (whorezone.party)',
        },
        body,
        signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) {
        throw new Error(`Discord token exchange returned ${tokenResponse.status}.`);
    }
    const token = await tokenResponse.json();
    if (!token || typeof token.access_token !== 'string') {
        throw new Error('Discord token exchange returned no access token.');
    }
    const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: 'application/json',
            'User-Agent': 'GrokSlop (whorezone.party)',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!userResponse.ok) {
        throw new Error(`Discord identity lookup returned ${userResponse.status}.`);
    }
    const user = await userResponse.json();
    if (!accessStore.isSnowflake(user?.id)) {
        throw new Error('Discord identity lookup returned no user id.');
    }
    return {
        id: String(user.id),
        username: accessStore.cleanName(user.username) || String(user.id),
        globalName: accessStore.cleanName(user.global_name),
    };
}

module.exports = {
    SESSION_COOKIE,
    isConfigured,
    isOwner,
    hostnameOf,
    isLoopbackHost,
    isAllowedHost,
    externalOrigin,
    authorizeRequest,
    handleAuthRoutes,
    createSessionToken,
    readSession,
    roleOf,
};
