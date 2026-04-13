/** Discord max 2000; leave headroom for “(continued)” on follow-up sends. */
const DEFAULT_MAX = 1880;

/**
 * Split long text into chunks safe for Discord `content`.
 * Prefers breaking at newlines, then spaces, within the last third of a chunk.
 */
function splitDiscordContent(text, maxLen = DEFAULT_MAX) {
    const s = text == null ? '' : String(text);
    if (s.length <= maxLen) {
        return s ? [s] : [];
    }

    const parts = [];
    let i = 0;
    while (i < s.length) {
        const hardEnd = Math.min(i + maxLen, s.length);
        if (hardEnd >= s.length) {
            parts.push(s.slice(i).trimEnd());
            break;
        }

        const slice = s.slice(i, hardEnd);
        const minBreak = i + Math.floor(maxLen * 0.35);

        let breakAt = hardEnd;
        const nl = slice.lastIndexOf('\n');
        if (nl >= minBreak - i) {
            breakAt = i + nl + 1;
        } else {
            const sp = slice.lastIndexOf(' ');
            if (sp >= minBreak - i) {
                breakAt = i + sp + 1;
            }
        }

        const chunk = s.slice(i, breakAt).trimEnd();
        if (chunk) {
            parts.push(chunk);
        }
        i = breakAt;
    }

    return parts;
}

module.exports = {
    splitDiscordContent,
    DEFAULT_MAX,
};
