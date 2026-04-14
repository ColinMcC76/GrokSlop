const persona = require('./persona');
const config = require('../config');

function truncate(text, max = config.maxPromptCharsPerMessage) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildPrompt({ message, recentMessages, guildMemory, userMemory, attachments }) {
    const recentBlock = recentMessages
        .map(m => {
            const speaker = m.is_bot ? `${m.username} (bot)` : m.username;
            return `${speaker}: ${truncate(m.content)}`;
        })
        .join('\n');

    const guildMemoryBlock = guildMemory.length
        ? guildMemory.map(m => `- ${m.key}: ${m.value}`).join('\n')
        : 'None';

    const userMemoryBlock = userMemory.length
        ? userMemory.map(m => `- ${m.key}: ${m.value}`).join('\n')
        : 'None';

    const attachmentBlock = attachments.length
        ? attachments.map(a => {
            if (a.type === 'text') {
                return `[Text attachment: ${a.name}]\n${truncate(a.content, 2500)}`;
            }

            if (a.type === 'image') {
                return `[Image attachment: ${a.name}] ${a.url}`;
            }

            return '';
        }).join('\n\n')
        : 'None';

    return {
        instructions: persona.textChat,
        input: `
Guild memory:
${guildMemoryBlock}

User memory:
${userMemoryBlock}

Recent channel context:
${recentBlock || 'None'}

Current user:
${message.authorUsername}

Current message:
${message.content || '(no text content)'}

Attachments:
${attachmentBlock}

Write a Discord reply that fits the vibe and answers the user.
Do not mention hidden memory unless naturally relevant.
`.trim()
    };
}

module.exports = {
    buildPrompt
};