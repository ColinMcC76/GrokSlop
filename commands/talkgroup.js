const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinChannel, getConnectionData } = require('../services/voiceManager');
const { startRealtimeForGuild, isRealtimeActive } = require('../services/realtimeVoiceBridge');
const { realtimeGroup } = require('../ai/persona');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('talkgroup')
        .setDescription('Realtime voice: listen to everyone in the VC (not just you)'),
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
                content: 'Realtime voice is already active. Use /talkoff first, then /talkgroup or /talkon.',
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
            allowedSpeakerIds: null,
            textChannel: interaction.channel,
            instructions: realtimeGroup(),
        });

        await interaction.editReply(
            `🎙️ **Group mode** in **${voiceChannel.name}** — I am listening to **everyone** in this channel (not the bot).`
        );
    },
};
