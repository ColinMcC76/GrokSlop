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
const {
    stopGuild,
    isActive,
    ensureConnectDevice,
    getDiagnostics,
    getConnectMode,
} = require('../services/spotifyConnect');
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
                    `After linking, **${defaultDeviceName()}** should appear under Spotify → **Connect to a device** (same Premium account). ` +
                    `Use **/joinvc** so audio is heard in Discord.`,
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
            if (row && !isActive(guildId)) {
                try {
                    await ensureConnectDevice(guildId);
                } catch (e) {
                    console.error('[spotify] status ensureConnectDevice:', e);
                }
            }

            const diag = getDiagnostics(guildId);
            const inVoice = Boolean(getConnectionData(guildId));
            const mode = getConnectMode(guildId);

            const lines = [
                row
                    ? `**Linked** (device name: **${diag.deviceName}**).`
                    : '**Not linked.** Use `/spotify link`.',
                isActive(guildId)
                    ? `**Connect device running** (mode: ${mode ?? 'unknown'}). Look for **${diag.deviceName}** in Spotify → Connect.`
                    : row
                      ? `**Connect device not running.** Install **librespot** on the bot PC and set \`LIBRESPOT_PATH\` if needed.`
                      : '',
                diag.lastLog && !isActive(guildId)
                    ? `Last librespot log: \`${diag.lastLog}\``
                    : '',
                inVoice
                    ? 'Bot is **in a voice channel** (Discord audio when you play on the Connect device).'
                    : 'Bot is **not in voice** — use `/joinvc` to hear playback in Discord.',
                row
                    ? 'Use the **same Spotify Premium account** you linked when picking the device.'
                    : '',
            ].filter(Boolean);

            await interaction.reply({
                content: lines.join('\n').slice(0, 1900),
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
