const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    buildAuthorizeUrl,
    getGuildSpotifyRow,
    isConfigured,
    defaultDeviceName,
} = require('../services/spotifyAuth');
const {
    createOAuthState,
    parseRedirectInput,
    completeSpotifyLink,
} = require('../services/spotifyOAuthServer');
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
        )
        .addSubcommand((sub) =>
            sub
                .setName('finish')
                .setDescription(
                    'Complete linking after Spotify login (paste redirect URL from browser)'
                )
                .addStringOption((o) =>
                    o
                        .setName('redirect')
                        .setDescription(
                            'Full browser URL after login (contains code= and state=)'
                        )
                        .setRequired(true)
                        .setMaxLength(2000)
                )
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
                    `**If the browser cannot reach the bot** (common when \`SPOTIFY_REDIRECT_URI\` is \`127.0.0.1\` and you are not on the bot PC): after login, copy the **entire** address bar and run \`/spotify finish\`.\n\n` +
                    `Otherwise you should get a success page and a **DM** from me when linking completes.\n\n` +
                    `Then pick **${defaultDeviceName()}** in Spotify → **Connect to a device**, and use **/joinvc** for Discord audio.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (sub === 'finish') {
            if (!isConfigured()) {
                await interaction.reply({
                    content: 'Spotify is not configured on the bot host.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const raw = interaction.options.getString('redirect', true);
                const { code, state } = parseRedirectInput(raw);
                const result = await completeSpotifyLink(
                    interaction.client,
                    code,
                    state,
                    { expectedUserId: interaction.user.id }
                );

                await interaction.editReply({
                    content: `Spotify linked.\n${result.discordMessage}`,
                });
            } catch (err) {
                await interaction.editReply({
                    content: err.message || String(err),
                });
            }
            return;
        }

        if (sub === 'unlink') {
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
