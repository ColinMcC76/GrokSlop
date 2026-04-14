const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueueSnapshot } = require('../services/youtubeQueue');

const MAX_UPCOMING = 15;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show upcoming YouTube tracks'),
    async execute(interaction) {
        const snap = getQueueSnapshot(interaction.guild.id);

        if (snap.total === 0) {
            await interaction.reply({
                content: 'The YouTube queue is empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const lines = [
            `**Now:** ${snap.current?.title || 'YouTube'}`,
            ...snap.upcoming.slice(0, MAX_UPCOMING).map((item, i) => {
                const title = item.title || 'YouTube';
                return `${i + 2}. ${title}`;
            }),
        ];

        if (snap.upcoming.length > MAX_UPCOMING) {
            lines.push(
                `_…and ${snap.upcoming.length - MAX_UPCOMING} more_`
            );
        }

        await interaction.reply({
            content: lines.join('\n'),
            flags: MessageFlags.Ephemeral,
        });
    },
};
