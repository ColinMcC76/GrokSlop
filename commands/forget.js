const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { deleteGuildMemory, deleteUserMemory } = require('../ai/memory');

const MAX_KEY = 80;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forget')
        .setDescription('Remove a note from Grokslop memory')
        .addStringOption((o) =>
            o
                .setName('scope')
                .setDescription('Where the note was stored')
                .setRequired(true)
                .addChoices(
                    { name: 'Whole server (guild)', value: 'guild' },
                    { name: 'Just me', value: 'me' }
                )
        )
        .addStringOption((o) =>
            o.setName('key').setDescription('Label to remove').setRequired(true)
        ),
    async execute(interaction) {
        const scope = interaction.options.getString('scope', true);
        let key = interaction.options.getString('key', true).trim();

        if (!key) {
            await interaction.reply({
                content: 'Key cannot be empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (key.length > MAX_KEY) {
            key = key.slice(0, MAX_KEY);
        }

        const guildId = interaction.guild.id;
        let removed;

        if (scope === 'guild') {
            removed = deleteGuildMemory(guildId, key);
        } else {
            removed = deleteUserMemory(guildId, interaction.user.id, key);
        }

        await interaction.reply({
            content:
                removed > 0
                    ? `Removed **${key}**.`
                    : `No entry found for **${key}**.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
