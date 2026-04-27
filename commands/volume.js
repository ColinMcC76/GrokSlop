const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getConnectionData } = require('../services/voiceManager');
const { setYoutubeVolume, getYoutubeVolume } = require('../services/youtubeQueue');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('YouTube playback volume (0–100, steps of 5)')
        .addIntegerOption((option) =>
            option
                .setName('percent')
                .setDescription('Volume percentage')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(100)
        ),
    async execute(interaction) {
        const percent = interaction.options.getInteger('percent', true);
        if (percent % 5 !== 0) {
            await interaction.reply({
                content: 'Volume must be in steps of **5** (0, 5, 10, … 100).',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const data = getConnectionData(interaction.guild.id);
        if (!data) {
            await interaction.reply({
                content:
                    'The bot is not in a voice channel. Use **/play** or **/joinvc** first, then set volume.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        try {
            setYoutubeVolume(interaction.guild.id, data.player, percent);
        } catch (err) {
            await interaction.reply({
                content: err.message || String(err),
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const current = getYoutubeVolume(interaction.guild.id);
        await interaction.reply(
            `YouTube volume set to **${current}%** (applies to the current and future queued tracks).`
        );
    },
};
