module.exports = {
    botName: process.env.BOT_NAME || 'grokslop',
    model: process.env.OPENAI_MODEL || 'gpt-5.2',
    recentMessageLimit: 20,
    maxTextAttachmentChars: 6000,
    /** Extracted text from PDF/DOCX/XLSX (larger than plain .txt). */
    maxDocumentAttachmentChars: 12_000,
    /** Skip parsing attachments larger than this (bytes). */
    maxAttachmentBytes: 12 * 1024 * 1024,
    /** Cap rows exported per Excel sheet. */
    maxSpreadsheetRowsPerSheet: 250,
    cooldownMs: 8000,
    maxPromptCharsPerMessage: 1800,
    guildMemoryLimit: 20,
    userMemoryLimit: 10,
    /** How often to poll YouTube RSS for new uploads. */
    youtubeFeedPollMs: Number(process.env.YOUTUBE_FEED_POLL_MS) || 5 * 60 * 1000,
    /** Fallback Discord channel name when no destination is set with /ytfeed. */
    youtubeFeedChannelName: process.env.YOUTUBE_FEED_CHANNEL_NAME || 'youtube-feed',
    /** Daily transcript brief destination (name match, emoji optional). */
    youtubeFeedSummaryChannelName:
        process.env.YOUTUBE_FEED_SUMMARY_CHANNEL_NAME || 'political-spyte-club🥊'
};