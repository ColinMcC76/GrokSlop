const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const {
    buildAuthorizeUrl,
    getGuildSpotifyRow,
    isConfigured,
    defaultDeviceName,
} = require('../services/spotifyAuth');
const { createOAuthState } = require('../services/spotifyOAuthServer');
const { stopGuild, isActive } = require('../services/spotifyConnect');
const { getConnectionData } = require('../services/voiceManager');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotify')
        .setDescription('Link Spotify Connect for this server (Premium, one device per server)')
        .addSubcommand((sub) =>
            sub
                .setName('link')
                .setDescription('Link a Spotify account to this server')
        )
        .addSubcommand((sub) =>
            sub.setName('unlink').setDescription('Disconnect Spotify for this server')
        )
        .addSubcommand((sub) =>
            sub.setName('status').setDescription('Spotify link and speaker status')
        ),
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        if (sub === 'link') {
            if (!isConfigured()) {
                await interaction.reply({
                    content:
                        'Spotify is not configured on the bot host (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`).',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (
                !interaction.memberPermissions.has(
                    PermissionFlagsBits.ManageGuild
                )
            ) {
                await interaction.reply({
                    content: 'You need **Manage Server** to link Spotify.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (isRealtimeActive(guildId)) {
                await interaction.reply({
                    content: 'Turn off realtime voice (/talkoff) before starting Spotify Connect.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const state = createOAuthState(guildId, interaction.user.id);
            const url = buildAuthorizeUrl(state, guildId, interaction.user.id);

            await interaction.reply({
                content:
                    `Open this link to authorize Spotify (**Premium** required):\n${url}\n\n` +
                    `After linking, join a voice channel (or use **/joinvc**). ` +
                    `In the Spotify app, open **Connect to a device** and choose **${defaultDeviceName()}**. ` +
                    `Control playlists from your phone as usual.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (sub === 'unlink') {
            if (
                !interaction.memberPermissions.has(
                    PermissionFlagsBits.ManageGuild
                )
            ) {
                await interaction.reply({
                    content: 'You need **Manage Server** to unlink Spotify.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await stopGuild(guildId, true);
            await interaction.reply({
                content: 'Spotify unlinked for this server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (sub === 'status') {
            const row = getGuildSpotifyRow(guildId);
            const inVoice = Boolean(getConnectionData(guildId));
            const lines = [
                row
                    ? `**Linked** (device name: **${row.device_name || defaultDeviceName()}**).`
                    : '**Not linked.** Use `/spotify link`.',
                inVoice
                    ? 'Bot is **in a voice channel**.'
                    : 'Bot is **not in voice** — use `/joinvc` so audio can play here.',
                isActive(guildId)
                    ? '**Connect speaker** is active (choose this device in the Spotify app).'
                    : row && inVoice
                      ? 'Linked, but speaker is not running — try `/joinvc` again.'
                      : row
                        ? 'Speaker starts when the bot joins voice.'
                        : '',
            ].filter(Boolean);

            await interaction.reply({
                content: lines.join('\n'),
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
