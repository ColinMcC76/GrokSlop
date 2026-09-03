const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YT_VIDEO_ID_RE = /^[\w-]{11}$/;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_HEADERS = {
    // YouTube's RSS endpoint 404s browser-like Mozilla UAs; a simple client string works.
    'User-Agent': 'GrokSlop-YouTubeFeed/1.0',
    Accept: 'application/atom+xml, application/xml, text/xml, text/html;q=0.9,*/*;q=0.8',
};

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
 * @param {string} url
 * @param {string} [accept]
 * @returns {Promise<string>}
 */
async function fetchText(url, accept) {
    const res = await fetch(url, {
        headers: accept ? { ...FETCH_HEADERS, Accept: accept } : FETCH_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.text();
}

/**
 * @param {string} channelId
 * @returns {string}
 */
function rssUrlForChannel(channelId) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

/**
 * @param {string} channelId
 * @returns {Promise<{ channelId: string, channelTitle: string, entries: ReturnType<typeof parseYoutubeAtom>['entries'] }>}
 */
async function fetchChannelFeed(channelId) {
    let xml;
    try {
        xml = await fetchText(
            rssUrlForChannel(channelId),
            'application/atom+xml, application/xml, text/xml'
        );
    } catch (err) {
        if (/HTTP 404/.test(err.message || '')) {
            throw new Error(
                'No YouTube RSS feed found for that channel. Check the URL, @handle, or UC… ID.'
            );
        }
        throw err;
    }
    const parsed = parseYoutubeAtom(xml);
    parsed.channelId = YT_CHANNEL_ID_RE.test(channelId)
        ? channelId
        : parsed.channelId || channelId;
    return parsed;
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
 * Resolve a YouTube URL, @handle, or UC… id to a channel id.
 * @param {string} raw
 * @returns {Promise<string>}
 */
async function resolveChannelId(raw) {
    const input = String(raw || '').trim();
    if (!input) {
        throw new Error('Provide a YouTube channel URL, @handle, or channel ID.');
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
            'Could not parse that as a YouTube channel. Use a URL, @handle, or UC… channel ID.'
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
        'Could not find a channel in that YouTube URL. Paste a channel page, @handle, or UC… ID.'
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
    parseYoutubeAtom,
    extractChannelIdFromHtml,
    rssUrlForChannel,
    fetchChannelFeed,
    resolveChannelId,
    formatNewVideoMessage,
};
