const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * @param {{
 *   title: string,
 *   channelName: string,
 *   videoId: string,
 *   text: string
 * }} payload
 * @returns {Promise<string>}
 */
async function summarizeYoutubeTranscript(payload) {
    const title = payload.title || 'YouTube video';
    const channelName = payload.channelName || 'YouTube';
    const videoId = payload.videoId;
    let text = String(payload.text || '').trim();
    if (!text) {
        throw new Error('Transcript was empty; cannot write a brief.');
    }
    if (text.length > MAX_TRANSCRIPT_CHARS) {
        text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[transcript truncated for length]`;
    }

    const instructions = `You rewrite a YouTube intelligence/news transcript as a Discord wire brief.

Voice:
- Write in active voice, as if YOU are delivering the wire. Same cadence as the host.
- State facts directly: "Iran struck American bases in Kuwait overnight."
- Never write "the speaker says", "he says", "the speaker emphasizes", "according to the speaker", or any narrator attribution.
- Do not mention the channel name, the host, or that this came from a video.

Structure:
- Start with **BLUF** — one tight sentence of the bottom line. Do not add a timestamp/date section; the title already has the date.
- Then short **bold** geographic or topic headings and bullets.
- Cover every major detail: events, places, people, numbers, weapons, units, contractors, casualties, and named sources in the transcript.
- If the host hedges or is unsure, keep that hedge in active voice ("Attribution is still murky") rather than reporting that he said it.
- Skip ads, sponsor reads, outros, and "this concludes the wire".
- No **Watch items** unless there is a concrete thing to monitor that is not already in BLUF.

Hard limits:
- Output ONLY the brief. Do not paste, quote, or append the transcript.
- Do not repeat the video title, URL, channel, or date.
- Do not write a "Wire Timestamp" or "From …" line.`;

    const input = `Title (already shown to the reader — do not repeat it): ${title}
Channel (already shown — do not repeat it): ${channelName}

Transcript:
${text}`;

    const { generateResponse } = require('../ai/router');
    const result = await generateResponse({
        instructions,
        input,
        attachments: [],
        useWebSearch: false,
    });

    const body =
        typeof result === 'string'
            ? result.trim()
            : String(result?.text || '').trim();
    if (!body) {
        throw new Error('Summary model returned no text.');
    }

    const header = `📡 **${title}**\nhttps://youtu.be/${videoId}`;
    return `${header}\n\n${stripBriefNoise(body, title, channelName)}`;
}

/**
 * Drop repeated source/date lines and a dumped raw transcript after the brief.
 * @param {string} body
 * @param {string} title
 * @param {string} channelName
 */
function stripBriefNoise(body, title, channelName) {
    let text = String(body || '').trim();

    const dropLine = [
        /^\s*from\s+.+$/i,
        /^\s*wire timestamp\s*$/i,
        /^\s*\*\*wire timestamp\*\*\s*$/i,
        /^\s*daily brief\s*[—-].+$/i,
    ];
    if (channelName) {
        dropLine.push(
            new RegExp(
                `^\\s*from\\s+${escapeRegExp(channelName)}\\s*$`,
                'i'
            )
        );
    }
    if (title) {
        dropLine.push(new RegExp(`^\\s*${escapeRegExp(title)}\\s*$`, 'i'));
    }

    text = text
        .split(/\r?\n/)
        .filter((line) => !dropLine.some((re) => re.test(line.trim())))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const echo = text.search(
        /\n(?:this is the wire|this concludes the wire)\b/i
    );
    if (echo >= 0 && /\*\*[^*]+\*\*/.test(text.slice(0, echo))) {
        text = text.slice(0, echo).trim();
    }

    return text;
}

/**
 * @param {string} value
 */
function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    summarizeYoutubeTranscript,
    stripBriefNoise,
    MAX_TRANSCRIPT_CHARS,
};
