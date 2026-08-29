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
    findPendingStateForGuildUser,
    getConnectInstructions,
    deliverSpotifyLinkReply,
} = require('../services/spotifyLink');
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

function truncateDiscord(content, max = 1950) {
    if (content.length <= max) {
        return content;
    }
    return `${content.slice(0, max - 1)}…`;
}

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
                            'Full browser URL after login (contains code=)'
                        )
                        .setRequired(true)
                        .setMaxLength(2000)
                )
        ),
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const deviceName = defaultDeviceName();

        if (sub === 'link') {
            if (!isConfigured()) {
                await interaction.reply({
                    content:
                        'Spotify Connect is not set up on this bot. The host needs `LIBRESPOT_PATH` in `.env` (see docs/librespot-windows.md).',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (isRealtimeActive(guildId)) {
                await interaction.reply({
                    content: 'Turn off realtime voice (`/talkoff`) before linking Spotify.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.deferReply();

            try {
                await interaction.editReply(
                    '**Link Spotify to GrokSlop** — generating login link…'
                );

                const { authorizeUrl } = await beginSpotifyLink(
                    guildId,
                    interaction.user.id
                );

                await deliverSpotifyLinkReply(
                    interaction,
                    deviceName,
                    authorizeUrl
                );
            } catch (err) {
                console.error('[spotify] /spotify link failed:', err);
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
                parseRedirectInput(raw);

                const state = findPendingStateForGuildUser(
                    guildId,
                    interaction.user.id
                );
                if (!state) {
                    throw new Error(
                        'No pending login for this server. Run `/spotify link` first, then paste the URL here within 15 minutes.'
                    );
                }

                const result = await finishSpotifyLink(
                    interaction.client,
                    raw,
                    state
                );

                await interaction.editReply(
                    truncateDiscord(
                        `**Spotify linked.**\n\n${result.discordMessage}`
                    )
                );
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
                    ? `**Linked** — Connect device: **${diag.deviceName}**.`
                    : getGuildSpotifyRow(guildId)
                      ? '**Stale link** — credentials missing. Run `/spotify unlink` then `/spotify link`.'
                      : '**Not linked.** Run `/spotify link` to set up Spotify Connect.',
                linked && isActive(guildId)
                    ? `**Connect device running** (mode: ${mode ?? 'unknown'}).`
                    : linked
                      ? `**Connect device not running.** ${diag.lastLog ? `Last log: \`${diag.lastLog}\`` : 'Check the bot console.'}`
                      : '',
                diag.lastLog && !isActive(guildId)
                    ? `Last librespot log: \`${diag.lastLog}\``
                    : '',
                inVoice
                    ? 'Bot is **in a voice channel** — playback on the Connect device is heard in Discord.'
                    : 'Bot is **not in voice** — run `/joinvc` before playing.',
            ].filter(Boolean);

            if (linked) {
                lines.push('', getConnectInstructions(diag.deviceName));
            } else {
                lines.push(
                    '',
                    '**Setup:** `/spotify link` → log in in browser → copy address bar URL → `/spotify finish`.'
                );
            }

            await interaction.reply({
                content: truncateDiscord(lines.join('\n')),
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
