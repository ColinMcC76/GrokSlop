const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getRecentMessages } = require('../ai/memory');
const { generateResponse } = require('../ai/router');
const { splitDiscordContent } = require('../utils/discordChunks');
const { withCustomPersona } = require('../ai/persona');
const { getActivePromptText } = require('../ai/guildPersonas');

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 5;
const MAX_LIMIT = 50;
const MAX_TRANSCRIPT_CHARS = 12_000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('summarize')
        .setDescription('Summarize recent messages in this channel')
        .addIntegerOption((o) =>
            o
                .setName('limit')
                .setDescription(`How many recent messages (${MIN_LIMIT}–${MAX_LIMIT})`)
                .setMinValue(MIN_LIMIT)
                .setMaxValue(MAX_LIMIT)
                .setRequired(false)
        ),
    async execute(interaction) {
        const rawLimit =
            interaction.options.getInteger('limit') ?? DEFAULT_LIMIT;
        const limit = Math.min(
            MAX_LIMIT,
            Math.max(MIN_LIMIT, rawLimit)
        );

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const rows = getRecentMessages(interaction.channel.id, limit);
        if (rows.length === 0) {
            await interaction.editReply({
                content: 'No saved messages in this channel yet.',
            });
            return;
        }

        const lines = rows.map((r) => {
            const who = r.is_bot ? `${r.username} (bot)` : r.username;
            const text = (r.content || '').replace(/\s+/g, ' ').trim() || '(no text)';
            return `${who}: ${text}`;
        });

        let transcript = lines.join('\n');
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
            transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
        }

        const baseInstructions = `You summarize a short excerpt of a Discord text channel.
Output a concise bullet list of the main topics and any clear decisions or action items.
Do not invent messages or facts that are not implied by the excerpt.
If the excerpt is mostly noise or off-topic, say so briefly.`;

        const instructions = withCustomPersona(
            baseInstructions,
            getActivePromptText(interaction.guild.id)
        );

        const input = `Recent messages in this channel (oldest first among this batch):\n\n${transcript}`;

        let result;
        try {
            result = await generateResponse({
                instructions,
                input,
                attachments: [],
                useWebSearch: false,
            });
        } catch (err) {
            console.error('[summarize]', err);
            await interaction.editReply({
                content: 'Could not generate a summary right now.',
            });
            return;
        }

        const text =
            typeof result === 'string'
                ? result
                : (result.text || 'Summary unavailable.');
        const chunks = splitDiscordContent(text, 1900);

        if (chunks.length === 0) {
            await interaction.editReply({ content: 'Summary was empty.' });
            return;
        }

        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            const body = chunks[i];
            const piece = body.startsWith('*(continued)*')
                ? body
                : `*(continued)*\n${body}`;
            await interaction.followUp({
                content: piece,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
