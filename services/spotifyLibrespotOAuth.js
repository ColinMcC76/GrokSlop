const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
 * Remove cached login so librespot prints a fresh OAuth URL.
 * @param {string} guildId
 */
function clearLibrespotCredentials(guildId) {
    try {
        fs.rmSync(credentialsPath(guildId), { force: true });
    } catch {}
}

/**
 * librespot prints "Browse to: …" with println! to stdout. When stdout is a pipe,
 * Rust block-buffers it and the URL may not flush before librespot waits on stdin.
 * Wrap the spawn with a PTY or line-buffer helper when available.
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} spawnOptions
 */
function spawnLibrespotOAuth(args, spawnOptions) {
    /** @type {{ command: string, args: string[], label: string }[]} */
    const wrappers = [];

    if (process.platform !== 'win32') {
        wrappers.push({
            command: 'script',
            args: ['-q', '/dev/null', LIBRESPOT_BIN, ...args],
            label: 'script',
        });
        wrappers.push({
            command: 'stdbuf',
            args: ['-oL', '-eL', LIBRESPOT_BIN, ...args],
            label: 'stdbuf',
        });
    } else {
        for (const root of [
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            process.env.LOCALAPPDATA &&
                path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
        ].filter(Boolean)) {
            const usrBin = path.join(root, 'Git', 'usr', 'bin');
            const stdbufExe = path.join(usrBin, 'stdbuf.exe');
            if (fs.existsSync(stdbufExe)) {
                wrappers.push({
                    command: stdbufExe,
                    args: ['-oL', '-eL', LIBRESPOT_BIN, ...args],
                    label: 'git-stdbuf',
                });
            }
            const winptyExe = path.join(usrBin, 'winpty.exe');
            if (fs.existsSync(winptyExe)) {
                wrappers.push({
                    command: winptyExe,
                    args: [LIBRESPOT_BIN, ...args],
                    label: 'winpty',
                });
            }
        }
    }

    wrappers.push({
        command: LIBRESPOT_BIN,
        args,
        label: 'direct',
    });

    for (const wrapper of wrappers) {
        try {
            const proc = spawn(wrapper.command, wrapper.args, spawnOptions);
            if (wrapper.label !== 'direct') {
                console.log(
                    `[spotify-oauth] using ${wrapper.label} wrapper for librespot OAuth stdout`
                );
            } else {
                console.warn(
                    '[spotify-oauth] spawning librespot without a PTY/line-buffer wrapper; ' +
                        'OAuth URL capture may fail on some platforms (install Git for Windows stdbuf on Windows).'
                );
            }
            return proc;
        } catch (err) {
            if (wrapper.label === 'direct') {
                throw err;
            }
        }
    }

    throw new Error(`Could not spawn librespot OAuth process at "${LIBRESPOT_BIN}".`);
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
    ];
}

/**
 * @param {string} chunk
 * @param {string} combined
 * @returns {string | null}
 */
function extractAuthorizeUrl(combined) {
    const browseMatch = combined.match(
        /Browse to:\s*(https:\/\/accounts\.spotify\.com\/authorize[^\s\r\n]+)/i
    );
    if (browseMatch) {
        return browseMatch[1].trim();
    }

    const directMatch = combined.match(
        /(https:\/\/accounts\.spotify\.com\/authorize[^\s\r\n]+)/i
    );
    if (directMatch) {
        return directMatch[1].trim();
    }

    return null;
}

/**
 * @param {import('node:child_process').ChildProcess} proc
 * @param {(chunk: string) => void} onOutput
 */
function wireOAuthOutput(proc, onOutput) {
    const handle = (chunk) => {
        onOutput(chunk.toString());
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    return () => {
        proc.stdout.off('data', handle);
        proc.stderr.off('data', handle);
    };
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

    const proc = spawnLibrespotOAuth(buildOAuthSpawnArgs(guildId, deviceName), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
            ...process.env,
            // Avoid extra prompts; URL must appear on stdout/stderr for Discord.
            NO_COLOR: '1',
            TERM: process.env.TERM || 'dumb',
        },
        cwd: os.tmpdir(),
    });

    pendingByGuild.set(guildId, { proc, guildId, userId });

    return new Promise((resolve, reject) => {
        let settled = false;
        let combined = '';
        let unwire = () => {};

        const finish = (err, url) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            unwire();
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
                    'Timed out waiting for Spotify login URL. Check LIBRESPOT_PATH and the bot console log.'
                )
            );
        }, 45_000);

        const onOutput = (text) => {
            combined += text;
            const line = text.trim();
            if (line) {
                console.log(`[spotify-oauth:${guildId}]`, line);
            }

            if (/ENOENT|not found/i.test(combined)) {
                finish(
                    new Error(
                        `librespot not found at "${LIBRESPOT_BIN}". Set LIBRESPOT_PATH in .env.`
                    )
                );
                return;
            }

            const url = extractAuthorizeUrl(combined);
            if (url) {
                finish(null, url);
            }
        };

        unwire = wireOAuthOutput(proc, onOutput);

        proc.on('error', (err) => {
            finish(err);
        });

        proc.on('close', (code) => {
            if (!settled) {
                finish(
                    new Error(
                        `librespot OAuth exited before showing a login URL (code ${code ?? '?'}). ${combined.slice(-400)}`
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
        let unwire = () => {};

        const finish = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearInterval(credPoll);
            unwire();
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
            const line = chunk.toString().trim();
            if (line) {
                console.log(`[spotify-oauth:${guildId}]`, line);
            }

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

        unwire = wireOAuthOutput(proc, onData);

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
    clearLibrespotCredentials,
    startHeadlessOAuth,
    completeHeadlessOAuth,
    cancelPendingOAuth,
    isLibrespotOAuthPending,
    normalizeLibrespotRedirect,
};
