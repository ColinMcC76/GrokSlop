const { splitDiscordContent } = require('./discordChunks');

/**
 * Transcript messages for a sound-off. Mentions are suppressed so this never pings.
 * @param {string} body
 * @returns {{ content: string, allowedMentions: { parse: [] } }[]}
 */
function soundOffPayloads(body) {
    const text = String(body || '').trim();
    if (!text) {
        throw new Error('Generated equipment check was empty.');
    }
    return splitDiscordContent(text).map((content) => ({
        content,
        allowedMentions: { parse: [] },
    }));
}

module.exports = {
    soundOffPayloads,
};
