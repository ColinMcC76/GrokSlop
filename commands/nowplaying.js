const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueueSnapshot } = require('../services/youtubeQueue');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show the current YouTube track in the queue'),
    async execute(interaction) {
        const snap = getQueueSnapshot(interaction.guild.id);

        if (!snap.current) {
            await interaction.reply({
                content: 'Nothing in the YouTube queue.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply({
            content: `**Now playing:** ${snap.current.title || 'YouTube'}\n${snap.current.url}`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
