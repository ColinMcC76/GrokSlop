const { generateResponse } = require('../ai/router');

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

    const instructions = `You write a daily intelligence brief from a YouTube video transcript for a Discord politics channel.

Rules:
- Cover every major detail: claims, events, dates, locations, people/groups, numbers, weapons, and named sources.
- Use short bold section headings and bullets. Be specific. No vague recap.
- Do not invent facts, dates, or names that are not in the transcript. If the speaker hedges or is unsure, say so.
- Do not add outside news or your own world knowledge.
- Skip ads, sponsor reads, and channel housekeeping.
- Keep it readable in Discord (about 400–900 words unless the video is packed).
- End with a short **Watch items** section only if the speaker flags things to monitor.`;

    const input = `Channel: ${channelName}
Title: ${title}
URL: https://youtu.be/${videoId}

Transcript:
${text}`;

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

    const header = `📡 **Daily brief — ${title}**\nhttps://youtu.be/${videoId}\nFrom ${channelName}\n`;
    const alreadyHasLink = body.includes(`youtu.be/${videoId}`);
    return alreadyHasLink ? body : `${header}\n${body}`;
}

module.exports = {
    summarizeYoutubeTranscript,
    MAX_TRANSCRIPT_CHARS,
};
