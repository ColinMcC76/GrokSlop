const { Events } = require('discord.js');
const { saveMessage, getRecentMessages, getGuildMemory, getUserMemory } = require('../ai/memory');
const { buildPrompt } = require('../ai/promptBuilder');
const { generateResponse } = require('../ai/router');
const { extractAttachments } = require('../utils/attachmentReader');
const { isCoolingDown, startCooldown } = require('../utils/cooldowns');
const { needsWebSearch } = require('../ai/needsWebSearch');

function shouldRespond(message, clientUserId) {
    if (message.author.bot) return false;
    if (!message.guild) return false;

    const mentioned = message.mentions.users.has(clientUserId);
    const isReplyToBot =
        message.reference?.messageId &&
        message.mentions.repliedUser &&
        message.mentions.repliedUser.id === clientUserId;

    return mentioned || isReplyToBot;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        try {
            saveMessage({
                id: message.id,
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id,
                username: message.author.username,
                content: message.content || '',
                isBot: false,
                createdAt: message.createdTimestamp
            });

            if (!shouldRespond(message, message.client.user.id)) return;

            const cooldownKey = `${message.guild.id}:${message.author.id}`;
            if (isCoolingDown(cooldownKey)) {
                return;
            }

            startCooldown(cooldownKey);

            await message.channel.sendTyping();

            const attachments = await extractAttachments(message);
            const recentMessages = getRecentMessages(message.channel.id);
            const guildMemory = getGuildMemory(message.guild.id);
            const userMemory = getUserMemory(message.guild.id, message.author.id);
            const useWebSearch = needsWebSearch(message.content);

            const prompt = buildPrompt({
                message: {
                    content: message.content,
                    authorUsername: message.author.username
                },
                recentMessages,
                guildMemory,
                userMemory,
                attachments
            });

            const result = await generateResponse({
                instructions: prompt.instructions,
                input: prompt.input,
                attachments,
                useWebSearch
            });

            const replyText = typeof result === 'string'
                ? result
                : (result.text || 'I had a thought and then it escaped.');

            const sent = await message.reply(replyText.slice(0, 1900));
            
            saveMessage({
                id: sent.id,
                guildId: sent.guild.id,
                channelId: sent.channel.id,
                userId: sent.author.id,
                username: sent.author.username,
                content: sent.content || '',
                isBot: true,
                createdAt: sent.createdTimestamp
            });
        } catch (error) {
            console.error('messageCreate handler failed:', error);
            await message.reply('I tried to think but the wires crossed.');
        }
    }
};