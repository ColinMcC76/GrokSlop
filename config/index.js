module.exports = {
    botName: process.env.BOT_NAME || 'grokslop',
    /** Chat / briefs via Responses API. Luna is the GPT-5.6 nano-cost tier. */
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    /** none | low | medium | high | xhigh | max. Luna defaults to medium. */
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'medium',
    /** /say and equipment-check speech. No reasoning.effort on audio/speech. */
    ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.OPENAI_TTS_VOICE || 'cedar',
    /** /talkon voice. gpt-realtime-2.1 is the reasoning speech-to-speech model. */
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
    realtimeVoice:
        process.env.OPENAI_REALTIME_VOICE ||
        process.env.OPENAI_TTS_VOICE ||
        'cedar',
    realtimeReasoningEffort:
        process.env.OPENAI_REALTIME_REASONING_EFFORT ||
        process.env.OPENAI_REASONING_EFFORT ||
        'medium',
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