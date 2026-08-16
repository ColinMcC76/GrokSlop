const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LIBRESPOT_BIN = process.env.LIBRESPOT_PATH || 'librespot';

/** @type {Map<string, { proc: import('node:child_process').ChildProcess, guildId: string, userId: string }>} */
const pendingByGuild = new Map();

function spotifyDataDir(guildId) {
    const dir = path.join(__dirname, '..', 'data', 'spotify', guildId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function systemCacheDir(guildId) {
    const dir = path.join(spotifyDataDir(guildId), 'system');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function audioCacheDir(guildId) {
    const dir = path.join(spotifyDataDir(guildId), 'audio');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function credentialsPath(guildId) {
    return path.join(systemCacheDir(guildId), 'credentials.json');
}

function hasLibrespotCredentials(guildId) {
    try {
        const p = credentialsPath(guildId);
        return fs.existsSync(p) && fs.statSync(p).size > 8;
    } catch {
        return false;
    }
}

function clearLibrespotCache(guildId) {
    try {
        fs.rmSync(spotifyDataDir(guildId), { recursive: true, force: true });
    } catch {}
}

/**
 * @param {string} guildId
 * @param {string} deviceName
 */
function buildOAuthSpawnArgs(guildId, deviceName) {
    return [
        '--name',
        deviceName,
        '--device-type',
        'speaker',
        '--backend',
        'pipe',
        '--format',
        's16',
        '--cache',
        audioCacheDir(guildId),
        '--system-cache',
        systemCacheDir(guildId),
        '--disable-discovery',
        '--enable-oauth',
        '--oauth-port',
        '0',
        '--quiet',
    ];
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string} deviceName
 * @returns {Promise<string>} authorize URL
 */
async function startHeadlessOAuth(guildId, userId, deviceName) {
    if (pendingByGuild.has(guildId)) {
        cancelPendingOAuth(guildId);
    }

    const proc = spawn(LIBRESPOT_BIN, buildOAuthSpawnArgs(guildId, deviceName), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });

    pendingByGuild.set(guildId, { proc, guildId, userId });

    return new Promise((resolve, reject) => {
        let settled = false;
        let combined = '';

        const finish = (err, url) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            proc.stderr.off('data', onData);
            if (err) {
                cancelPendingOAuth(guildId);
                reject(err);
            } else {
                resolve(url);
            }
        };

        const timer = setTimeout(() => {
            finish(
                new Error(
                    'librespot OAuth timed out. Check LIBRESPOT_PATH and try again.'
                )
            );
        }, 45_000);

        const onData = (chunk) => {
            combined += chunk.toString();
            console.log(`[spotify-oauth:${guildId}]`, chunk.toString().trim());

            if (/ENOENT|not found/i.test(combined)) {
                finish(
                    new Error(
                        `librespot not found at "${LIBRESPOT_BIN}". Set LIBRESPOT_PATH in .env.`
                    )
                );
                return;
            }

            const match = combined.match(/Browse to:\s*(https:\/\/[^\s\r\n]+)/i);
            if (match) {
                finish(null, match[1].trim());
            }
        };

        proc.stderr.on('data', onData);

        proc.on('error', (err) => {
            finish(err);
        });

        proc.on('close', (code) => {
            if (!settled) {
                finish(
                    new Error(
                        `librespot OAuth exited before showing a login URL (code ${code ?? '?'}).`
                    )
                );
            }
        });
    });
}

function cancelPendingOAuth(guildId) {
    const pending = pendingByGuild.get(guildId);
    if (!pending) {
        return;
    }
    try {
        pending.proc.kill('SIGKILL');
    } catch {}
    pendingByGuild.delete(guildId);
}

/**
 * @param {string} raw
 */
function normalizeLibrespotRedirect(raw) {
    const s = raw.trim();
    if (!s) {
        throw new Error('Paste the full redirect URL from your browser.');
    }

    let url;
    try {
        if (/^https?:\/\//i.test(s)) {
            url = new URL(s);
        } else if (s.startsWith('?')) {
            url = new URL(`http://127.0.0.1/login${s}`);
        } else if (s.includes('code=')) {
            url = new URL(`http://127.0.0.1/login?${s.replace(/^\?/, '')}`);
        } else {
            throw new Error('unrecognized');
        }
    } catch {
        throw new Error(
            'Could not parse that URL. After Spotify login, copy the **entire** address bar (it should contain `code=` and look like `http://127.0.0.1/login?code=...`).'
        );
    }

    const code = url.searchParams.get('code');
    if (!code) {
        throw new Error('That URL is missing `code=`. Copy the full address bar after Spotify login.');
    }

    return url.toString();
}

/**
 * @param {string} guildId
 * @param {string} redirectRaw
 */
async function completeHeadlessOAuth(guildId, redirectRaw) {
    const pending = pendingByGuild.get(guildId);
    if (!pending) {
        throw new Error(
            'No pending Spotify login for this server. Run `/spotify link` first.'
        );
    }

    const redirectUrl = normalizeLibrespotRedirect(redirectRaw);
    const { proc } = pending;

    return new Promise((resolve, reject) => {
        let settled = false;
        let combined = '';

        const finish = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearInterval(credPoll);
            proc.stderr.off('data', onData);
            pendingByGuild.delete(guildId);

            if (err) {
                try {
                    proc.kill('SIGKILL');
                } catch {}
                reject(err);
                return;
            }

            try {
                proc.kill('SIGTERM');
            } catch {}

            resolve();
        };

        const timer = setTimeout(() => {
            if (hasLibrespotCredentials(guildId)) {
                finish(null);
            } else {
                finish(
                    new Error(
                        'Spotify login timed out. Run `/spotify link` and `/spotify finish` again.'
                    )
                );
            }
        }, 60_000);

        const credPoll = setInterval(() => {
            if (hasLibrespotCredentials(guildId)) {
                finish(null);
            }
        }, 400);

        const onData = (chunk) => {
            combined += chunk.toString();
            console.log(`[spotify-oauth:${guildId}]`, chunk.toString().trim());

            if (
                /INVALID_CREDENTIALS|Bad credentials|could not initialize|Permission denied/i.test(
                    combined
                )
            ) {
                finish(
                    new Error(
                        'Spotify rejected the login. Use a **Premium** account and try `/spotify link` again.'
                    )
                );
            }
        };

        proc.stderr.on('data', onData);

        proc.on('close', (code) => {
            if (hasLibrespotCredentials(guildId)) {
                finish(null);
                return;
            }
            if (!settled) {
                finish(
                    new Error(
                        `librespot OAuth failed (exit ${code ?? '?'}). ${combined.slice(-300)}`
                    )
                );
            }
        });

        try {
            proc.stdin.write(`${redirectUrl}\n`);
        } catch (e) {
            finish(e);
        }
    });
}

function isLibrespotOAuthPending(guildId) {
    return pendingByGuild.has(guildId);
}

module.exports = {
    audioCacheDir,
    systemCacheDir,
    hasLibrespotCredentials,
    clearLibrespotCache,
    startHeadlessOAuth,
    completeHeadlessOAuth,
    cancelPendingOAuth,
    isLibrespotOAuthPending,
    normalizeLibrespotRedirect,
};
