const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'error.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;

let initialized = false;
let writing = false;
/** @type {Console['error'] | null} */
let originalConsoleError = null;
/** @type {Console['warn'] | null} */
let originalConsoleWarn = null;

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function formatArg(arg) {
    if (arg instanceof Error) {
        return arg.stack || arg.message || String(arg);
    }
    if (typeof arg === 'object') {
        try {
            return JSON.stringify(arg);
        } catch {
            return util.inspect(arg, { depth: 4, breakLength: 120 });
        }
    }
    return String(arg);
}

/**
 * @param {unknown[]} args
 */
function serializeArgs(args) {
    return args.map(formatArg).join(' ');
}

/**
 * @param {string} level
 * @param {string} source
 * @param {string} message
 * @param {string} [detail]
 */
function appendLine(level, source, message, detail) {
    ensureLogDir();
    rotateIfNeeded();

    const timestamp = new Date().toISOString();
    const head = `${timestamp} [${level.toUpperCase()}] [${source}] ${message}`;
    const line = detail ? `${head}\n${detail}\n` : `${head}\n`;

    if (writing) {
        return;
    }

    writing = true;
    try {
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
        originalConsoleError?.('[errorLog] failed to write log:', err);
    } finally {
        writing = false;
    }
}

function rotateIfNeeded() {
    try {
        if (!fs.existsSync(LOG_FILE)) {
            return;
        }
        const size = fs.statSync(LOG_FILE).size;
        if (size < MAX_LOG_BYTES) {
            return;
        }

        for (let i = MAX_ROTATED_FILES; i >= 1; i -= 1) {
            const src =
                i === 1 ? LOG_FILE : path.join(LOG_DIR, `error.log.${i - 1}`);
            const dest = path.join(LOG_DIR, `error.log.${i}`);
            if (fs.existsSync(src)) {
                if (fs.existsSync(dest)) {
                    fs.unlinkSync(dest);
                }
                fs.renameSync(src, dest);
            }
        }
    } catch (err) {
        originalConsoleError?.('[errorLog] rotation failed:', err);
    }
}

/**
 * @param {string} source
 * @param {unknown} err
 * @param {Record<string, unknown>} [meta]
 */
function logError(source, err, meta) {
    const message =
        err instanceof Error
            ? err.message || 'Error'
            : typeof err === 'string'
              ? err
              : serializeArgs([err]);
    const detail =
        err instanceof Error && err.stack
            ? err.stack
            : meta
              ? serializeArgs([meta])
              : '';

    appendLine('error', source, message, detail || undefined);

    if (meta) {
        appendLine('error', source, 'context', serializeArgs([meta]));
    }

    originalConsoleError?.(`[${source}]`, err, meta ?? '');
}

/**
 * @param {string} source
 * @param {unknown} warning
 * @param {Record<string, unknown>} [meta]
 */
function logWarn(source, warning, meta) {
    const message =
        warning instanceof Error
            ? warning.message
            : typeof warning === 'string'
              ? warning
              : serializeArgs([warning]);
    const detail = meta ? serializeArgs([meta]) : undefined;
    appendLine('warn', source, message, detail);
}

/**
 * @param {unknown[]} args
 */
function captureConsole(level, args) {
    const message = serializeArgs(args);
    appendLine(level, 'console', message);
}

/**
 * @param {import('discord.js').Client} [client]
 */
function initErrorLog(client) {
    if (initialized) {
        return;
    }
    initialized = true;
    ensureLogDir();

    originalConsoleError = console.error.bind(console);
    originalConsoleWarn = console.warn.bind(console);

    console.error = (...args) => {
        originalConsoleError(...args);
        captureConsole('error', args);
    };

    console.warn = (...args) => {
        originalConsoleWarn(...args);
        captureConsole('warn', args);
    };

    process.on('uncaughtException', (err) => {
        logError('uncaughtException', err);
        originalConsoleError('[errorLog] uncaughtException:', err);
    });

    process.on('unhandledRejection', (reason) => {
        logError('unhandledRejection', reason);
        originalConsoleError('[errorLog] unhandledRejection:', reason);
    });

    if (client) {
        client.on('error', (err) => {
            logError('discord.client', err);
        });
        client.on('warn', (info) => {
            logWarn('discord.client', info);
        });
    }

    appendLine('info', 'boot', `GrokSlop error log started (pid ${process.pid})`);
    originalConsoleError('[errorLog] writing to', LOG_FILE);
}

/**
 * @param {{ maxLines?: number, maxChars?: number }} [opts]
 */
function readRecentLog(opts = {}) {
    const maxLines = Math.min(Math.max(opts.maxLines ?? 40, 1), 200);
    const maxChars = Math.min(Math.max(opts.maxChars ?? 1800, 200), 3900);

    if (!fs.existsSync(LOG_FILE)) {
        return '(no errors logged yet)';
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const tail = lines.slice(-maxLines).join('\n');

    if (tail.length <= maxChars) {
        return tail || '(log file is empty)';
    }

    return `…${tail.slice(tail.length - maxChars + 1)}`;
}

function getLogFilePath() {
    ensureLogDir();
    return LOG_FILE;
}

function logFileExists() {
    return fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 0;
}

function clearLogs() {
    ensureLogDir();
    for (const file of fs.readdirSync(LOG_DIR)) {
        if (file.startsWith('error.log')) {
            fs.unlinkSync(path.join(LOG_DIR, file));
        }
    }
    appendLine('info', 'errorlog', 'Log cleared via /errorlog clear');
}

/**
 * @param {import('discord.js').GuildMember | null} member
 * @param {string} userId
 */
function canViewErrorLog(member, userId) {
    const allowList = process.env.ERRORLOG_USER_IDS?.split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    if (allowList?.includes(userId)) {
        return true;
    }
    if (member?.permissions?.has('ManageGuild')) {
        return true;
    }
    return false;
}

module.exports = {
    initErrorLog,
    logError,
    logWarn,
    readRecentLog,
    getLogFilePath,
    logFileExists,
    clearLogs,
    canViewErrorLog,
};
