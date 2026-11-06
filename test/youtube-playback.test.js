const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');
const {
    YTDLP_FORMAT_SORT,
    YTDLP_META_SEPARATOR,
    defaultAudioFormat,
    m3u8AudioFormat,
    resolvedAudioFormat,
    isHeaderOverflow,
    isPlayDlPageParseError,
    playDlLookupIsBroken,
    parseYtdlpMetadata,
    isYouTubePlaylistUrl,
    ytdlpLookupTarget,
    lookupFailure,
} = require('../services/youtubeFormats');
const {
    MIN_HTTP_HEADER_SIZE,
    planHeaderBump,
    stripHeaderSizeArgs,
} = require('../utils/raiseHttpHeaderLimit');

test('audio format prefers the original track over a smaller auto-dub', () => {
    const format = defaultAudioFormat();
    const original = format.indexOf('format_note*=original');
    const preference = format.indexOf('language_preference>=10');
    const plain = format.indexOf('/bestaudio/best');
    assert.ok(original >= 0);
    assert.ok(original < preference);
    assert.ok(preference < plain);
    assert.equal(YTDLP_FORMAT_SORT, 'lang,+abr');
    assert.ok(YTDLP_FORMAT_SORT.startsWith('lang'));
    assert.equal(resolvedAudioFormat(''), format);
    assert.equal(resolvedAudioFormat('  ba[language^=ja]  '), 'ba[language^=ja]');
});

test('m3u8 fallback still asks for original audio first', () => {
    const format = m3u8AudioFormat();
    assert.ok(format.startsWith('bestaudio[format_note*=original][protocol=m3u8_native]'));
    assert.ok(format.endsWith('/bestaudio/best'));
});

test('header overflow and play-dl page failures are recognized', () => {
    const overflow = Object.assign(new Error('Parse Error: Header overflow'), {
        code: 'HPE_HEADER_OVERFLOW',
    });
    assert.equal(isHeaderOverflow(overflow), true);
    assert.equal(isHeaderOverflow(new Error('socket hang up')), false);
    assert.equal(
        isPlayDlPageParseError(new Error('Initial Response Data is undefined.')),
        true
    );
    assert.equal(playDlLookupIsBroken(overflow), true);
    assert.equal(playDlLookupIsBroken(new Error('No YouTube results found.')), false);
});

test('yt-dlp metadata lines become queue rows', () => {
    const sep = YTDLP_META_SEPARATOR;
    const stdout = [
        `English Song${sep}185${sep}dQw4w9WgXcQ${sep}https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
        `No Url${sep}NA${sep}abcdefghijk${sep}NA`,
        'not a metadata line',
        '',
    ].join('\n');
    const rows = parseYtdlpMetadata(stdout);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'English Song',
        durationInSec: 185,
    });
    assert.equal(rows[1].url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(rows[1].title, 'No Url');
    assert.equal(rows[1].durationInSec, null);
});

test('lookup target keeps a video url and searches plain text', () => {
    assert.deepEqual(
        ytdlpLookupTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
        {
            target: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            playlist: false,
        }
    );
    assert.equal(
        isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PLtest'),
        true
    );
    assert.deepEqual(ytdlpLookupTarget('never gonna give you up'), {
        target: 'ytsearch1:never gonna give you up',
        playlist: false,
    });
    assert.equal(
        ytdlpLookupTarget('https://music.youtube.com/playlist?list=OLAK').playlist,
        true
    );
});

test('header overflow lookup tells the user to restart', () => {
    const err = lookupFailure(
        Object.assign(new Error('Parse Error: Header overflow'), {
            code: 'HPE_HEADER_OVERFLOW',
        }),
        new Error('yt-dlp is not installed or not on PATH.')
    );
    assert.match(err.message, /header overflow/i);
    assert.match(err.message, /Restart GrokSlop/);
    assert.match(err.message, /yt-dlp is not installed/);
});

test('header bump plan replaces a too-small limit and does not loop', () => {
    const plan = planHeaderBump({
        maxHeaderSize: 16384,
        envFlag: undefined,
        isMain: true,
        execPath: process.execPath,
        execArgv: ['--max-http-header-size=8192', '--require', 'dotenv/config'],
        argv: [process.execPath, 'index.js'],
    });
    assert.ok(plan);
    assert.deepEqual(stripHeaderSizeArgs(plan.args).slice(0, 2), [
        '--require',
        'dotenv/config',
    ]);
    assert.ok(plan.args.includes(`--max-http-header-size=${MIN_HTTP_HEADER_SIZE}`));
    assert.equal(plan.args.at(-1), 'index.js');
    assert.equal(
        planHeaderBump({
            maxHeaderSize: 16384,
            envFlag: '1',
            isMain: true,
            execPath: process.execPath,
            execArgv: [],
            argv: ['node', 'index.js'],
        }),
        null
    );
    assert.equal(
        planHeaderBump({
            maxHeaderSize: MIN_HTTP_HEADER_SIZE,
            isMain: true,
            execPath: process.execPath,
            execArgv: [],
            argv: ['node', 'index.js'],
        }),
        null
    );
});

test('npm start uses the same header limit as the re-exec', () => {
    assert.match(
        pkg.scripts.start,
        new RegExp(`--max-http-header-size=${MIN_HTTP_HEADER_SIZE}(?:\\s|$)`)
    );
});

test('node honors a larger max http header size', () => {
    const result = spawnSync(
        process.execPath,
        [
            `--max-http-header-size=${MIN_HTTP_HEADER_SIZE}`,
            '-e',
            'process.stdout.write(String(require("node:http").maxHeaderSize))',
        ],
        { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), MIN_HTTP_HEADER_SIZE);
});
