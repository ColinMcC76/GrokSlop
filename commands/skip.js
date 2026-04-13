const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getConnectionData } = require('../services/voiceManager');
const { skip } = require('../services/youtubeQueue');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current YouTube track in the queue'),
    async execute(interaction) {
        if (!getConnectionData(interaction.guild.id)) {
            await interaction.reply({
                content: 'I am not in a voice channel.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const ok = skip(interaction.guild.id);
        if (!ok) {
            await interaction.reply({
                content: 'Nothing is playing or queued.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply('Skipped.');
    },
};
