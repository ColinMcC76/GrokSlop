const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinChannel, getConnectionData } = require('../services/voiceManager');
const { startRealtimeForGuild, isRealtimeActive } = require('../services/realtimeVoiceBridge');
const { realtimeSolo } = require('../ai/persona');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('talkon')
               .setDescription('Start realtime voice chat with Shabbot in your VC'),
    async execute(interaction) {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const voiceChannel = member.voice.channel;

        if (!voiceChannel) {
            await interaction.reply({
                content: 'You need to be in a voice channel first.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (isRealtimeActive(interaction.guild.id)) {
            await interaction.reply({
                content: 'Realtime voice is already active in this server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        let connectionData = getConnectionData(interaction.guild.id);
        if (!connectionData) {
            connectionData = await joinChannel(voiceChannel);
        }

        await startRealtimeForGuild({
            guildId: interaction.guild.id,
            guild: interaction.guild,
            connection: connectionData.connection,
            player: connectionData.player,
            allowedSpeakerIds: new Set([interaction.user.id]),
            textChannel: interaction.channel,
            instructions: realtimeSolo(),
        });

        await interaction.editReply(`🎙️ Realtime voice mode is on in **${voiceChannel.name}**. I am listening to **${interaction.user.username}**.`);
    },
};