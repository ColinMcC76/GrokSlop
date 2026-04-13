module.exports = {
    botName: process.env.BOT_NAME || 'grokslop',
    model: process.env.OPENAI_MODEL || 'gpt-5.2',
    recentMessageLimit: 20,
    maxTextAttachmentChars: 6000,
    cooldownMs: 8000,
    maxPromptCharsPerMessage: 1800,
    guildMemoryLimit: 20,
    userMemoryLimit: 10
};