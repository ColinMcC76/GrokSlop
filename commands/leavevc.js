const { SlashCommandBuilder } = require('discord.js');
const { leaveChannel } = require('../services/voiceManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leavevc')
        .setDescription('Leave the current voice channel'),
    async execute(interaction) {
        const left = leaveChannel(interaction.guild.id);

        if (!left) {
            await interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
            return;
        }

        await interaction.reply('Left the voice channel.');
    }
};