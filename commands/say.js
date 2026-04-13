const { SlashCommandBuilder } = require('discord.js');
const { getConnectionData, playAudio } = require('../services/voiceManager');
const { generateSpeech } = require('../services/tts');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');
const fs = require('node:fs');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Make Grokslop say something in voice chat')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('What Grokslop should say')
                .setRequired(true)),
    async execute(interaction) {
        const text = interaction.options.getString('text');

        if (isRealtimeActive(interaction.guild.id)) {
            await interaction.reply({
                content: 'Realtime voice is currently active. Use /talkoff before using /say.',
                flags: 64
            });
            return;
        }

        const connectionData = getConnectionData(interaction.guild.id);
        if (!connectionData) {
            await interaction.reply({
                content: 'I need to be in a voice channel first. Use /joinvc.',
                flags: 64
            });
            return;
        }

        await interaction.deferReply();

        try {
            const audioPath = await generateSpeech(text);
            console.log('[TTS DEBUG] audioPath:', audioPath, 'exists:', fs.existsSync(audioPath));

            await playAudio(interaction.guild.id, audioPath);

            await interaction.editReply(`Said: ${text}`);
        } catch (error) {
            console.error('say command failed:', error);
            await interaction.editReply('I tried to speak and immediately fumbled it.');
        }
    }
};