const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinChannel, getConnectionData } = require('../services/voiceManager');
const { startRealtimeForGuild, isRealtimeActive } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('talkon')
        .setDescription('Start realtime voice chat with Grokslop in your VC'),
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
            connection: connectionData.connection,
            player: connectionData.player,
            userId: interaction.user.id,
            textChannel: interaction.channel,
            instructions: `
You are Grokslop in a Discord voice chat.
Be helpful, natural, and conversational.
Keep spoken replies fairly short.
You are a little funny and chaotic, but still useful.
Do not ramble unless asked.
`,
        });

        await interaction.editReply(`🎙️ Realtime voice mode is on in **${voiceChannel.name}**. I am listening to **${interaction.user.username}**.`);
    },
};