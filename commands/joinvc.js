const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinChannel } = require('../services/voiceManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joinvc')
        .setDescription('Join your current voice channel'),
    async execute(interaction) {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const voiceChannel = member.voice.channel;

        console.log('[JOINVC DEBUG]', {
            user: interaction.user.tag,
            memberId: member.id,
            voiceChannelId: voiceChannel?.id ?? null,
            voiceChannelName: voiceChannel?.name ?? null
        });

        if (!voiceChannel) {
            await interaction.reply({
                content: 'You need to be in a voice channel first.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await joinChannel(voiceChannel);
        await interaction.reply(`Joined **${voiceChannel.name}**`);
    }
};