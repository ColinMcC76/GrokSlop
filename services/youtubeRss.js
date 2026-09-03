const { spawn } = require('node:child_process');
const fs = require('node:fs');

const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YT_VIDEO_ID_RE = /^[\w-]{11}$/;
const FETCH_TIMEOUT_MS = 15_000;
const CURL_TIMEOUT_MS = 25_000;
const YTDLP_TIMEOUT_MS = 45_000;
const FETCH_HEADERS = {
    'User-Agent': 'GrokSlop-YouTubeFeed/1.0',
    Accept: '*/*',
};

const RSS_HEADER_ATTEMPTS = [
    { 'User-Agent': 'GrokSlop-YouTubeFeed/1.0', Accept: '*/*' },
    { 'User-Agent': 'curl/8.7.1', Accept: '*/*' },
];

/** @type {string | null} */
let loggedFetchVia = null;

/**
 * Strip Discord/markdown wrapping so pasted RSS URLs and IDs still parse.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeInput(raw) {
    return String(raw || '')
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        .trim()
        .replace(/^<([^>]+)>$/, '$1')
        .replace(/^['"`]+|['"`]+$/g, '')
        .trim();
}

/**
 * YouTube RSS often omits the `UC` prefix on `<yt:channelId>`.
 * @param {string} id
 * @returns {string}
 */
function normalizeChannelId(id) {
    const raw = String(id || '').trim();
    if (YT_CHANNEL_ID_RE.test(raw)) {
        return raw;
    }
    if (/^[A-Za-z0-9_-]{22}$/.test(raw)) {
        const withPrefix = `UC${raw}`;
        if (YT_CHANNEL_ID_RE.test(withPrefix)) {
            return withPrefix;
        }
    }
    return raw;
}

/**
 * @param {string} id
 * @returns {string}
 */
function rssUrlForChannel(id) {
    if (YT_CHANNEL_ID_RE.test(id)) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
    }
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(id)}`;
}

/**
 * Channel RSS plus the uploads playlist (UC… → UU…), which YouTube sometimes serves when channel_id 404s.
 * @param {string} id
 * @returns {string[]}
 */
function rssUrlCandidates(id) {
    /** @type {string[]} */
    const urls = [];
    const seen = new Set();
    const add = (url) => {
        if (url && !seen.has(url)) {
            seen.add(url);
            urls.push(url);
        }
    };

    if (YT_CHANNEL_ID_RE.test(id)) {
        add(rssUrlForChannel(id));
        add(
            `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(`UU${id.slice(2)}`)}`
        );
        add(
            `https://youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`
        );
    } else if (id) {
        add(rssUrlForChannel(id));
    }
    return urls;
}

/**
 * @param {URL} url
 * @returns {{ type: 'channel' | 'playlist' | 'user', id: string, feedUrl: string } | null}
 */
function parseYoutubeRssUrl(url) {
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host !== 'youtube.com') {
        return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'feeds' || parts[1] !== 'videos.xml') {
        return null;
    }

    const channelId = url.searchParams.get('channel_id');
    if (channelId) {
        const id = normalizeChannelId(channelId);
        return {
            type: 'channel',
            id,
            feedUrl: rssUrlForChannel(id),
        };
    }

    const playlistId = url.searchParams.get('playlist_id');
    if (playlistId) {
        return {
            type: 'playlist',
            id: playlistId,
            feedUrl: rssUrlForChannel(playlistId),
        };
    }

    const user = url.searchParams.get('user');
    if (user) {
        return {
            type: 'user',
            id: user,
            feedUrl: `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(user)}`,
        };
    }

    return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = Number(dec);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&amp;/g, '&');
}

/**
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
function xmlText(block, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i');
    const m = block.match(re);
    if (!m) {
        return '';
    }
    return decodeXmlEntities(m[1]).trim();
}

/**
 * @param {string} xml
 * @returns {{ channelId: string, channelTitle: string, entries: Array<{
 *   videoId: string,
 *   title: string,
 *   published: string,
 *   publishedMs: number,
 *   author: string,
 *   url: string
 * }> }}
 */
function parseYoutubeAtom(xml) {
    if (!xml || typeof xml !== 'string') {
        throw new Error('Empty RSS body');
    }
    if (!/<feed[\s>]/i.test(xml)) {
        throw new Error('Response was not a YouTube RSS feed');
    }

    const feedHead = xml.split(/<entry[\s>]/i)[0] || xml;
    const channelId = normalizeChannelId(
        xmlText(feedHead, 'yt:channelId') ||
            (feedHead.match(/yt:channel:((?:UC)?[A-Za-z0-9_-]{22})/) || [])[1] ||
            ''
    );
    const channelTitle = xmlText(feedHead, 'title');

    /** @type {Array<{videoId: string, title: string, published: string, publishedMs: number, author: string, url: string}>} */
    const entries = [];
    const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
    let m;
    while ((m = entryRe.exec(xml))) {
        const block = m[1];
        const videoId =
            xmlText(block, 'yt:videoId') ||
            (block.match(/yt:video:([\w-]{11})/) || [])[1] ||
            '';
        if (!YT_VIDEO_ID_RE.test(videoId)) {
            continue;
        }
        const title = xmlText(block, 'title');
        const published = xmlText(block, 'published');
        const author = xmlText(block, 'name') || channelTitle;
        entries.push({
            videoId,
            title,
            published,
            publishedMs: Date.parse(published) || 0,
            author,
            url: `https://youtu.be/${videoId}`,
        });
    }

    entries.sort((a, b) => a.publishedMs - b.publishedMs);
    return { channelId, channelTitle, entries };
}

/**
 * @param {string} html
 * @returns {string | null}
 */
function extractChannelIdFromHtml(html) {
    if (!html) {
        return null;
    }
    const patterns = [
        /<link\s+rel="canonical"\s+href="https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/i,
        /property="og:url"\s+content="https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/i,
        /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})/,
        /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
        /"browseId":"(UC[A-Za-z0-9_-]{22})"/,
        /<meta\s+itemprop="channelId"\s+content="(UC[A-Za-z0-9_-]{22})"/i,
        /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) {
            return m[1];
        }
    }
    return null;
}

/**
 * @param {string} via
 */
function logFetchViaOnce(via) {
    if (loggedFetchVia === via) {
        return;
    }
    loggedFetchVia = via;
    console.log(`[youtubeFeed] reading channel videos via ${via}`);
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function spawnCollect(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${bin} timed out`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

/**
 * Netscape cookies.txt → Cookie header for youtube.com (same file as /play).
 * @returns {string}
 */
function youtubeCookieHeader() {
    const file = process.env.YT_DLP_COOKIES?.trim();
    if (!file) {
        return '';
    }
    try {
        if (!fs.existsSync(file)) {
            return '';
        }
        const cookies = [];
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line || line.startsWith('#')) {
                continue;
            }
            const cols = line.split('\t');
            if (cols.length < 7 || !/youtube\.com/i.test(cols[0] || '')) {
                continue;
            }
            cookies.push(`${cols[5]}=${String(cols[6] || '').trim()}`);
        }
        return cookies.join('; ');
    } catch {
        return '';
    }
}

/**
 * @param {string} url
 * @param {string} [accept]
 * @returns {Promise<string>}
 */
async function fetchText(url, accept) {
    const headers = accept ? { ...FETCH_HEADERS, Accept: accept } : { ...FETCH_HEADERS };
    const cookie = youtubeCookieHeader();
    if (cookie) {
        headers.Cookie = cookie;
    }
    const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.text();
}

/**
 * @param {string} url
 * @returns {Promise<string | null>}
 */
async function tryNodeFetchRss(url) {
    const cookie = youtubeCookieHeader();
    const attempts = cookie
        ? [
              { ...RSS_HEADER_ATTEMPTS[0], Cookie: cookie },
              ...RSS_HEADER_ATTEMPTS,
          ]
        : RSS_HEADER_ATTEMPTS;

    for (const headers of attempts) {
        try {
            const res = await fetch(url, {
                headers,
                redirect: 'follow',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const text = await res.text();
            if (res.ok && /<feed[\s>]/i.test(text)) {
                return text;
            }
        } catch {
            /* try next header / fallback */
        }
    }
    return null;
}

/**
 * Node's fetch (undici) is often 404/500'd by YouTube RSS on Windows; curl is not.
 * @param {string} url
 * @returns {Promise<string | null>}
 */
async function tryCurlRss(url) {
    const bins =
        process.platform === 'win32' ? ['curl.exe', 'curl'] : ['curl'];
    const args = [
        '-sS',
        '-L',
        '--compressed',
        '--max-time',
        '20',
        '-A',
        'curl/8.7.1',
        '-H',
        'Accept: */*',
        url,
    ];
    const cookieFile = process.env.YT_DLP_COOKIES?.trim();
    if (cookieFile && fs.existsSync(cookieFile)) {
        args.splice(args.length - 1, 0, '-b', cookieFile);
    }

    for (const bin of bins) {
        try {
            const { code, stdout } = await spawnCollect(
                bin,
                args,
                CURL_TIMEOUT_MS
            );
            if (code === 0 && /<feed[\s>]/i.test(stdout)) {
                return stdout;
            }
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                continue;
            }
        }
    }
    return null;
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseYtdlpTimestamp(raw) {
    if (typeof raw === 'number' && raw > 0) {
        return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string' && /^\d{8}$/.test(raw)) {
        const ms = Date.parse(
            `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`
        );
        return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
}

/**
 * @param {string} stdout
 * @param {string} channelId
 * @returns {{ channelId: string, channelTitle: string, entries: ReturnType<typeof parseYoutubeAtom>['entries'] } | null}
 */
function parseYtdlpFlat(stdout, channelId) {
    /** @type {ReturnType<typeof parseYoutubeAtom>['entries']} */
    const entries = [];
    let channelTitle = '';
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
            continue;
        }
        let row;
        try {
            row = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const videoId = row.id || row.display_id;
        if (!YT_VIDEO_ID_RE.test(String(videoId || ''))) {
            continue;
        }
        channelTitle =
            row.channel ||
            row.uploader ||
            row.playlist_channel ||
            row.playlist_title ||
            channelTitle;
        const publishedMs =
            parseYtdlpTimestamp(row.timestamp) ||
            parseYtdlpTimestamp(row.release_timestamp) ||
            parseYtdlpTimestamp(row.upload_date);
        entries.push({
            videoId,
            title: row.title || '',
            published: publishedMs ? new Date(publishedMs).toISOString() : '',
            publishedMs,
            author: row.channel || row.uploader || channelTitle,
            url: `https://youtu.be/${videoId}`,
        });
    }
    if (entries.length === 0 && !channelTitle) {
        return null;
    }
    entries.sort((a, b) => a.publishedMs - b.publishedMs);
    return {
        channelId,
        channelTitle,
        entries,
    };
}

/**
 * Same yt-dlp + cookies.txt path /play already uses.
 * @param {string} channelId
 * @returns {Promise<ReturnType<typeof parseYtdlpFlat>>}
 */
async function tryYtdlpFeed(channelId) {
    const bin = process.env.YT_DLP_PATH?.trim() || 'yt-dlp';
    const targets = YT_CHANNEL_ID_RE.test(channelId)
        ? [
              `https://www.youtube.com/playlist?list=UU${channelId.slice(2)}`,
              `https://www.youtube.com/channel/${channelId}/videos`,
          ]
        : [`https://www.youtube.com/playlist?list=${channelId}`];

    const cookieFile = process.env.YT_DLP_COOKIES?.trim();
    const cookieArgs =
        cookieFile && fs.existsSync(cookieFile)
            ? ['--cookies', cookieFile]
            : [];

    for (const target of targets) {
        try {
            const { code, stdout } = await spawnCollect(
                bin,
                [
                    '--flat-playlist',
                    '--dump-json',
                    '--playlist-end',
                    '15',
                    '--no-warnings',
                    '--ignore-no-formats-error',
                    '--skip-download',
                    ...cookieArgs,
                    target,
                ],
                YTDLP_TIMEOUT_MS
            );
            if (code !== 0) {
                continue;
            }
            const parsed = parseYtdlpFlat(stdout, channelId);
            if (parsed) {
                return parsed;
            }
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                return null;
            }
        }
    }
    return null;
}

/**
 * @param {string} xml
 * @param {string} [knownId]
 */
function stampParsedFeed(xml, knownId) {
    const parsed = parseYoutubeAtom(xml);
    if (knownId && YT_CHANNEL_ID_RE.test(knownId)) {
        parsed.channelId = knownId;
    } else if (!parsed.channelId && knownId) {
        parsed.channelId = knownId;
    }
    return parsed;
}

/**
 * @param {string[]} urls
 * @returns {Promise<{ xml: string, via: string } | null>}
 */
async function fetchRssXmlFromUrls(urls) {
    for (const url of urls) {
        const xml = await tryNodeFetchRss(url);
        if (xml) {
            return { xml, via: 'node-fetch' };
        }
    }
    for (const url of urls) {
        const xml = await tryCurlRss(url);
        if (xml) {
            return { xml, via: 'curl' };
        }
    }
    return null;
}

/**
 * @param {string} feedUrl
 * @param {string} [knownId]
 * @returns {Promise<{ channelId: string, channelTitle: string, entries: ReturnType<typeof parseYoutubeAtom>['entries'] }>}
 */
async function fetchFeedByUrl(feedUrl, knownId) {
    const urls = [feedUrl];
    if (knownId) {
        for (const extra of rssUrlCandidates(knownId)) {
            if (!urls.includes(extra)) {
                urls.push(extra);
            }
        }
    }

    const rss = await fetchRssXmlFromUrls(urls);
    if (rss) {
        logFetchViaOnce(rss.via);
        return { ...stampParsedFeed(rss.xml, knownId), via: rss.via };
    }

    if (knownId) {
        const fromYtdlp = await tryYtdlpFeed(knownId);
        if (fromYtdlp) {
            logFetchViaOnce('yt-dlp');
            return { ...fromYtdlp, via: 'yt-dlp' };
        }
    }

    throw new Error(
        'YouTube blocked the RSS request (HTTP 404/500 from Node). Restart after this update so GrokSlop can use curl or yt-dlp instead — the same cookies.txt as /play.'
    );
}

/**
 * @param {string} channelId
 * @returns {Promise<{ channelId: string, channelTitle: string, entries: ReturnType<typeof parseYoutubeAtom>['entries'] }>}
 */
async function fetchChannelFeed(channelId) {
    return fetchFeedByUrl(rssUrlForChannel(channelId), channelId);
}

/**
 * @param {string} pageUrl
 * @returns {Promise<string>}
 */
async function fetchChannelIdFromPage(pageUrl) {
    const html = await fetchText(pageUrl, 'text/html');
    const id = extractChannelIdFromHtml(html);
    if (!id) {
        throw new Error(`Could not find a YouTube channel ID at ${pageUrl}`);
    }
    return id;
}

/**
 * Resolve a YouTube RSS URL, channel URL, @handle, or UC… id to a channel/playlist id.
 * @param {string} raw
 * @returns {Promise<string>}
 */
async function resolveChannelId(raw) {
    const input = sanitizeInput(raw);
    if (!input) {
        throw new Error(
            'Provide a YouTube RSS URL, channel URL, @handle, or UC… channel ID.'
        );
    }

    if (YT_CHANNEL_ID_RE.test(input)) {
        return input;
    }

    if (/^@[\w.-]+$/.test(input)) {
        return fetchChannelIdFromPage(`https://www.youtube.com/${input}`);
    }

    let url;
    try {
        url = new URL(input);
    } catch {
        if (/^[\w.-]+$/.test(input)) {
            return fetchChannelIdFromPage(`https://www.youtube.com/@${input}`);
        }
        throw new Error(
            'Could not parse that as a YouTube channel. Use an RSS URL, channel URL, @handle, or UC… ID.'
        );
    }

    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (
        host !== 'youtube.com' &&
        host !== 'youtu.be' &&
        host !== 'music.youtube.com'
    ) {
        throw new Error('That URL is not a YouTube link.');
    }

    const rss = parseYoutubeRssUrl(url);
    if (rss) {
        if (rss.type === 'channel' || rss.type === 'playlist') {
            return rss.id;
        }
        const feed = await fetchFeedByUrl(rss.feedUrl);
        if (feed.channelId) {
            return feed.channelId;
        }
        throw new Error('That RSS feed did not include a YouTube channel ID.');
    }

    const parts = url.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' && parts[0] && YT_VIDEO_ID_RE.test(parts[0])) {
        return fetchChannelIdFromPage(`https://www.youtube.com/watch?v=${parts[0]}`);
    }

    if (parts[0] === 'channel' && parts[1] && YT_CHANNEL_ID_RE.test(parts[1])) {
        return parts[1];
    }

    if (parts[0] === 'shorts' && parts[1] && YT_VIDEO_ID_RE.test(parts[1])) {
        return fetchChannelIdFromPage(`https://www.youtube.com/watch?v=${parts[1]}`);
    }

    if (parts[0]?.startsWith('@')) {
        return fetchChannelIdFromPage(`https://www.youtube.com/${parts[0]}`);
    }

    if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) {
        return fetchChannelIdFromPage(
            `https://www.youtube.com/${parts[0]}/${parts[1]}`
        );
    }

    const videoId = url.searchParams.get('v');
    if (videoId && YT_VIDEO_ID_RE.test(videoId)) {
        return fetchChannelIdFromPage(
            `https://www.youtube.com/watch?v=${videoId}`
        );
    }

    throw new Error(
        'Could not find a channel in that YouTube URL. Paste the RSS feed (youtube.com/feeds/videos.xml?channel_id=…), a channel page, @handle, or UC… ID.'
    );
}

/**
 * @param {string} channelName
 * @param {string} videoId
 * @returns {string}
 */
function formatNewVideoMessage(channelName, videoId) {
    const name = channelName || 'a YouTube channel';
    return `📺 New video from ${name}!\nhttps://youtu.be/${videoId}`;
}

module.exports = {
    YT_CHANNEL_ID_RE,
    normalizeChannelId,
    sanitizeInput,
    parseYoutubeRssUrl,
    parseYoutubeAtom,
    extractChannelIdFromHtml,
    rssUrlForChannel,
    fetchChannelFeed,
    fetchFeedByUrl,
    resolveChannelId,
    formatNewVideoMessage,
};
