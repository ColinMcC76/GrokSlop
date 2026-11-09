const http = require('node:http');
const { spawn } = require('node:child_process');

/** YouTube watch/player replies routinely exceed Node's 16KB default. */
const MIN_HTTP_HEADER_SIZE = 262144;

/**
 * @param {string[]} argv
 */
function stripHeaderSizeArgs(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--max-http-header-size') {
            i += 1;
            continue;
        }
        if (typeof arg === 'string' && arg.startsWith('--max-http-header-size=')) {
            continue;
        }
        out.push(arg);
    }
    return out;
}

/**
 * @param {{
 *   maxHeaderSize: number,
 *   envFlag?: string,
 *   isMain: boolean,
 *   execPath: string,
 *   execArgv: string[],
 *   argv: string[],
 * }} input
 * @returns {{ command: string, args: string[], envFlag: string } | null}
 */
function planHeaderBump(input) {
    if (!input.isMain || input.envFlag === '1') {
        return null;
    }
    if ((input.maxHeaderSize || 0) >= MIN_HTTP_HEADER_SIZE) {
        return null;
    }
    return {
        command: input.execPath,
        args: [
            ...stripHeaderSizeArgs(input.execArgv),
            `--max-http-header-size=${MIN_HTTP_HEADER_SIZE}`,
            ...input.argv.slice(1),
        ],
        envFlag: '1',
    };
}

function isBotEntrypoint() {
    const entry = require.main?.filename || '';
    return /[/\\]index\.js$/i.test(entry);
}

/**
 * Re-exec this process with a larger HTTP header limit.
 * Node reads `--max-http-header-size` only at startup, which is what
 * `HPE_HEADER_OVERFLOW` from play-dl needs.
 * @returns {boolean} true when a child was spawned and the caller should stop
 */
function raiseHttpHeaderLimit() {
    const maxHeaderSize = http.maxHeaderSize || 0;
    if (
        process.env.GROK_HTTP_HEADER_BUMP === '1' &&
        maxHeaderSize < MIN_HTTP_HEADER_SIZE
    ) {
        console.warn(
            `[startup] HTTP header limit is still ${maxHeaderSize} bytes. ` +
                `YouTube lookups may hit header overflow until Node starts with --max-http-header-size=${MIN_HTTP_HEADER_SIZE}.`
        );
    }

    const plan = planHeaderBump({
        maxHeaderSize,
        envFlag: process.env.GROK_HTTP_HEADER_BUMP,
        isMain: isBotEntrypoint(),
        execPath: process.execPath,
        execArgv: process.execArgv,
        argv: process.argv,
    });
    if (!plan) {
        return false;
    }

    console.log(
        '[startup] Raising the HTTP header limit so YouTube replies do not overflow.'
    );

    const child = spawn(plan.command, plan.args, {
        stdio: 'inherit',
        env: { ...process.env, GROK_HTTP_HEADER_BUMP: plan.envFlag },
        windowsHide: true,
    });

    child.on('error', (err) => {
        console.error(
            '[startup] Could not re-run with a larger HTTP header limit:',
            err?.message || err
        );
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            try {
                process.kill(process.pid, signal);
            } catch {
                process.exit(1);
            }
            return;
        }
        process.exit(code == null ? 1 : code);
    });

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        try {
            process.on(sig, () => {
                if (!child.killed) {
                    child.kill(sig);
                }
            });
        } catch {
            // Some platforms do not support every signal.
        }
    }

    return true;
}

module.exports = {
    MIN_HTTP_HEADER_SIZE,
    stripHeaderSizeArgs,
    planHeaderBump,
    raiseHttpHeaderLimit,
};
