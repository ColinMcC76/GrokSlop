const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    getIntroSong,
    clearIntroSong,
    saveAndPlayIntro,
    playStoredIntro,
} = require('../services/introSong');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('introsong')
        .setDescription(
            'Save your personal entrance song (YouTube) and play it in voice'
        )
        .addStringOption((option) =>
            option
                .setName('query')
                .setDescription(
                    'YouTube link or search — saves as your intro and plays it now'
                )
                .setRequired(false)
        )
        .addBooleanOption((option) =>
            option
                .setName('clear')
                .setDescription('Remove your saved intro song')
                .setRequired(false)
        )
        .addBooleanOption((option) =>
            option
                .setName('play')
                .setDescription('Play your saved intro without changing it')
                .setRequired(false)
        ),
    async execute(interaction) {
        const query = interaction.options.getString('query');
        const clear = interaction.options.getBoolean('clear');
        const playOnly = interaction.options.getBoolean('play');

        if (clear) {
            clearIntroSong(interaction.user.id);
            await interaction.reply({
                content: 'Your intro song has been cleared. Walk in silence, legend.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (playOnly && !query) {
            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );
            if (!member.voice.channel) {
                await interaction.reply({
                    content:
                        'Join a voice channel first (or be in one with me already).',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.deferReply();
            try {
                const { title } = await playStoredIntro(
                    member,
                    interaction.channel
                );
                await interaction.editReply(
                    `Playing your intro: **${title || 'YouTube'}**`
                );
            } catch (err) {
                await interaction.editReply(
                    `Could not play intro: ${err.message || err}`
                );
            }
            return;
        }

        if (!query) {
            const row = getIntroSong(interaction.user.id);
            if (!row) {
                await interaction.reply({
                    content:
                        'No intro saved yet. Use `/introsong query:<youtube link or search>` to set one.\nWhen I am already in your voice channel, your intro auto-plays when you join.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const title = row.title || row.query;
            await interaction.reply({
                content: `Your intro: **${title}**\n\`${row.query}\`\n\nJoin voice while I am in the channel for the automatic entrance, or \`/introsong play:true\`.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const member = await interaction.guild.members.fetch(
            interaction.user.id
        );
        if (!member.voice.channel) {
            await interaction.reply({
                content:
                    'Join a voice channel first so I know where to blast your entrance.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        try {
            const { title } = await saveAndPlayIntro(
                member,
                interaction.channel,
                query
            );
            await interaction.editReply(
                `Intro locked in and playing: **${title || query}**\nI will also play this when you join voice while I am already in the channel.`
            );
        } catch (err) {
            console.error('[introsong] failed:', err);
            await interaction.editReply(
                `Could not set intro: ${err.message || err}`
            );
        }
    },
};
