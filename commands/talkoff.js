const { SlashCommandBuilder } = require('discord.js');
const { stopRealtimeForGuild } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('talkoff')
        .setDescription('Stop realtime voice chat with Grokslop'),
    async execute(interaction) {
        const stopped = await stopRealtimeForGuild(interaction.guild.id);

        if (!stopped) {
            await interaction.reply({
                content: 'Realtime voice was not active.',
                flags: 64,
            });
            return;
        }

        await interaction.reply('🛑 Realtime voice mode is off.');
    },
};