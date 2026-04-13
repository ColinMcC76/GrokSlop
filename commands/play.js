const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getConnectionData } = require('../services/voiceManager');
const { enqueue } = require('../services/youtubeQueue');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play audio from YouTube (URL, playlist, or search query)')
        .addStringOption((option) =>
            option
                .setName('query')
                .setDescription('YouTube link or search text')
                .setRequired(true)
        ),
    async execute(interaction) {
        const query = interaction.options.getString('query', true);

        if (isRealtimeActive(interaction.guild.id)) {
            await interaction.reply({
                content: 'Turn off realtime voice (/talkoff) before playing YouTube audio.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const connectionData = getConnectionData(interaction.guild.id);
        if (!connectionData) {
            await interaction.reply({
                content: 'Join a voice channel with /joinvc first.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        try {
            const { added, titles } = await enqueue(
                interaction.guild.id,
                connectionData.player,
                interaction.channel,
                query
            );

            const preview = titles.slice(0, 3).join(', ');
            const more =
                added > 3 ? ` (+${added - 3} more)` : '';
            await interaction.editReply(
                added === 1
                    ? `Queued: **${titles[0]}**`
                    : `Queued **${added}** tracks: ${preview}${more}`
            );
        } catch (err) {
            console.error('play command failed:', err);
            await interaction.editReply(
                `Could not queue that: ${err.message || err}`
            );
        }
    },
};
