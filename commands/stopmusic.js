const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getConnectionData } = require('../services/voiceManager');
const { stopAndClear } = require('../services/youtubeQueue');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stopmusic')
        .setDescription('Stop YouTube playback and clear the queue'),
    async execute(interaction) {
        if (!getConnectionData(interaction.guild.id)) {
            await interaction.reply({
                content: 'I am not in a voice channel.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const ok = stopAndClear(interaction.guild.id);
        if (!ok) {
            await interaction.reply({
                content: 'The music queue was already empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply('Stopped and cleared the queue.');
    },
};
