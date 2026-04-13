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

        await interaction.deferReply();

        try {
            await joinChannel(voiceChannel);
            await interaction.editReply(`Joined **${voiceChannel.name}**`);
        } catch (err) {
            console.error('[joinvc] voice connection failed:', err);
            const msg =
                err?.name === 'AbortError' || err?.code === 'ABORT_ERR'
                    ? 'Timed out connecting to voice. Check bot **Connect** / **Speak** permissions and try again.'
                    : `Could not join voice: ${err.message || err}`;
            await interaction.editReply(msg);
        }
    }
};
