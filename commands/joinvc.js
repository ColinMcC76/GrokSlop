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
            const raw = err?.message || String(err);
            let msg;
            if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
                msg =
                    'Timed out connecting to voice. Check bot **Connect** / **Speak** permissions and try again.';
            } else if (/521|502|503|504|Unexpected server response/i.test(raw)) {
                msg =
                    'Discord voice gateway returned a temporary error (often network or Cloudflare). Try `/joinvc` again in a few seconds.';
            } else {
                msg = `Could not join voice: ${raw}`;
            }
            await interaction.editReply(msg);
        }
    }
};
