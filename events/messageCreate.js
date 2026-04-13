const { Events } = require('discord.js');
const { saveMessage, getRecentMessages, getGuildMemory, getUserMemory } = require('../ai/memory');
const { buildPrompt } = require('../ai/promptBuilder');
const { generateResponse } = require('../ai/router');
const { extractAttachments } = require('../utils/attachmentReader');
const { isCoolingDown, startCooldown } = require('../utils/cooldowns');
const { needsWebSearch } = require('../ai/needsWebSearch');
const { splitDiscordContent } = require('../utils/discordChunks');

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

            const chunks = splitDiscordContent(replyText);
            if (chunks.length === 0) {
                return;
            }

            const first = await message.reply(chunks[0]);
            saveMessage({
                id: first.id,
                guildId: first.guild.id,
                channelId: first.channel.id,
                userId: first.author.id,
                username: first.author.username,
                content: first.content || '',
                isBot: true,
                createdAt: first.createdTimestamp
            });

            for (let c = 1; c < chunks.length; c++) {
                const body = chunks[c];
                const follow = await message.channel.send(
                    body.startsWith('*(continued)*') ? body : `*(continued)*\n${body}`
                );
                saveMessage({
                    id: follow.id,
                    guildId: follow.guild.id,
                    channelId: follow.channel.id,
                    userId: follow.author.id,
                    username: follow.author.username,
                    content: follow.content || '',
                    isBot: true,
                    createdAt: follow.createdTimestamp
                });
            }
        } catch (error) {
            console.error('messageCreate handler failed:', error);
            await message.reply('I tried to think but the wires crossed.');
        }
    }
};