const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    getGuildSpotifyRow,
    defaultDeviceName,
    isConfigured,
} = require('../services/spotifyAuth');
const {
    beginSpotifyLink,
    finishSpotifyLink,
    parseRedirectInput,
} = require('../services/spotifyOAuthServer');
const {
    stopGuild,
    isLinked,
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
                        'Set `LIBRESPOT_PATH` in `.env` to your librespot.exe (see docs/librespot-windows.md).',
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

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const url = await beginSpotifyLink(
                    guildId,
                    interaction.user.id
                );
                await interaction.editReply(
                    `Open this link to authorize Spotify (**Premium** required):\n${url}\n\n` +
                        `After you approve, the browser will usually show **connection refused** — that is **normal**.\n` +
                        `Copy the **entire** address bar (looks like \`http://127.0.0.1/login?code=...\`) and run **`/spotify finish`**.\n\n` +
                        `Then pick **${defaultDeviceName()}** in Spotify → **Connect**, and use **/joinvc** for Discord audio.`
                );
            } catch (err) {
                await interaction.editReply({
                    content: err.message || String(err),
                });
            }
            return;
        }

        if (sub === 'finish') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const raw = interaction.options.getString('redirect', true);
                let state;
                try {
                    if (!/127\.0\.0\.1\/login|localhost\/login/i.test(raw)) {
                        ({ state } = parseRedirectInput(raw));
                    }
                } catch {
                    /* librespot redirect may not include our state */
                }

                const result = await finishSpotifyLink(
                    interaction.client,
                    raw,
                    state,
                    {
                        expectedUserId: interaction.user.id,
                        guildId,
                    }
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
            const linked = isLinked(guildId);
            if (linked && !isActive(guildId)) {
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
                linked
                    ? `**Linked** (device name: **${diag.deviceName}**).`
                    : getGuildSpotifyRow(guildId)
                      ? '**Stale link** — credentials missing. Run `/spotify unlink` then `/spotify link`.'
                      : '**Not linked.** Use `/spotify link`.',
                linked && isActive(guildId)
                    ? `**Connect device running** (mode: ${mode ?? 'unknown'}). Look for **${diag.deviceName}** in Spotify → Connect.`
                    : linked
                      ? `**Connect device not running.** ${diag.lastLog ? `Last log: \`${diag.lastLog}\`` : 'Check bot console.'}`
                      : '',
                diag.lastLog && !isActive(guildId)
                    ? `Last librespot log: \`${diag.lastLog}\``
                    : '',
                inVoice
                    ? 'Bot is **in a voice channel** (Discord audio when you play on the Connect device).'
                    : 'Bot is **not in voice** — use `/joinvc` to hear playback in Discord.',
                linked
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
