const persona = require('./persona');
const { getActivePromptText } = require('./guildPersonas');
const config = require('../config');

function truncate(text, max = config.maxPromptCharsPerMessage) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildPrompt({
    guildId,
    message,
    recentMessages,
    guildMemory,
    userMemory,
    attachments,
    attachmentWarnings = [],
}) {
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
        ? attachments
              .map((a) => {
                  if (a.type === 'text' || a.type === 'document') {
                      const label =
                          a.type === 'document'
                              ? `${(a.format || 'file').toUpperCase()} document`
                              : 'Text attachment';
                      const truncNote = a.truncated
                          ? ' (content was truncated)'
                          : '';
                      return `[${label}: ${a.name}${truncNote}]\n${truncate(a.content, 4000)}`;
                  }

                  if (a.type === 'image') {
                      return `[Image attachment: ${a.name}] ${a.url}`;
                  }

                  return '';
              })
              .filter(Boolean)
              .join('\n\n')
        : 'None';

    const attachmentWarningBlock = attachmentWarnings.length
        ? attachmentWarnings.map((w) => `- ${w}`).join('\n')
        : '';

    const customPersona = guildId ? getActivePromptText(guildId) : null;

    return {
        instructions: persona.textChatWithPersona(customPersona),
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
${attachmentWarningBlock ? `\nAttachment notes:\n${attachmentWarningBlock}\n` : ''}
If document text is included above, use it to answer the user. Mention if something could not be read.

Write a Discord reply that fits the vibe and answers the user.
Do not mention hidden memory unless naturally relevant.
`.trim()
    };
}

module.exports = {
    buildPrompt
};