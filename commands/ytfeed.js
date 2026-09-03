const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');
const {
    addSubscription,
    removeSubscription,
    listSubscriptions,
    setDiscordChannel,
    resolveDiscordChannel,
    inspectAndPost,
    postTranscriptToChannel,
} = require('../services/youtubeFeed');
const config = require('../config');

function requireManageGuild(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('You need **Manage Server** to change the YouTube feed.');
    }
}

function feedChannelHint() {
    return `#${config.youtubeFeedChannelName || 'youtube-feed'}`;
}

function pollMinutes() {
    const ms = Number(config.youtubeFeedPollMs) || 5 * 60 * 1000;
    return Math.max(1, Math.round(ms / 60_000));
}

/**
 * @param {string} title
 */
function clipTitle(title, max = 80) {
    const t = String(title || '').replace(/\s+/g, ' ').trim() || '(untitled)';
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatVideoDate(ms) {
    if (!ms) {
        return '';
    }
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {{ dest: import('discord.js').GuildTextBasedChannel | null, canSend: boolean, subscriptions: number, posted: number, reports: Array<Record<string, any>> }} result
 */
function formatCheckReport(result) {
    const destLine = result.dest
        ? result.canSend
            ? `Post channel: ${result.dest}`
            : `Post channel: ${result.dest} (missing Send Messages)`
        : `No post channel — create **${feedChannelHint()}** or run \`/ytfeed channel\`.`;

    const blocks = result.reports.map((report) => {
        if (!report.ok) {
            return `**${report.title}** \`${report.channelId}\`\n• fetch failed: ${report.error}`;
        }

        const postedNote =
            report.posted > 0
                ? `posted **${report.posted}** now`
                : report.unseenCount > 0
                  ? `${report.unseenCount} new, not posted`
                  : 'nothing new to post';

        const lines = (report.latest || []).map((video, index) => {
            let status = 'already posted';
            if (!video.wasSeen && report.posted > 0) {
                status = 'posted now';
            } else if (!video.wasSeen) {
                status = 'NEW, not posted yet';
            } else if (
                index === 0 &&
                report.unseenCount === 0 &&
                report.posted > 0
            ) {
                status = 'already posted — force-sent';
            }
            const when = formatVideoDate(video.publishedMs);
            const date = when ? ` (${when})` : '';
            return `• ${status} — ${clipTitle(video.title)}${date}\n  ${video.url}`;
        });

        const body =
            lines.length > 0
                ? lines.join('\n')
                : '• feed loaded but listed no videos';

        return `**${report.title}** \`${report.channelId}\`\nvia ${report.via} — ${postedNote}\n${body}`;
    });

    const header = `Checked ${result.subscriptions} channel(s). ${destLine}`;
    return `${header}\n\n${blocks.join('\n\n')}`.slice(0, 1900);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ytfeed')
        .setDescription('Post new YouTube uploads to a Discord channel via RSS')
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Watch a YouTube channel for new videos')
                .addStringOption((o) =>
                    o
                        .setName('channel')
                        .setDescription(
                            'RSS URL, channel URL, @handle, or UC… ID'
                        )
                        .setRequired(true)
                        .setMaxLength(400)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Stop watching a YouTube channel')
                .addStringOption((o) =>
                    o
                        .setName('channel')
                        .setDescription('Channel name, RSS URL, @handle, or UC… ID')
                        .setRequired(true)
                        .setAutocomplete(true)
                        .setMaxLength(400)
                )
        )
        .addSubcommand((sub) =>
            sub.setName('list').setDescription('List watched YouTube channels')
        )
        .addSubcommand((sub) =>
            sub
                .setName('channel')
                .setDescription('Set the Discord channel for new-video posts')
                .addChannelOption((o) =>
                    o
                        .setName('destination')
                        .setDescription('Text channel to post in (default: this channel)')
                        .addChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('check')
                .setDescription(
                    'Fetch feeds now, show what is new, and post anything not yet posted'
                )
                .addStringOption((o) =>
                    o
                        .setName('channel')
                        .setDescription('Check one watched channel (default: all)')
                        .setRequired(false)
                        .setAutocomplete(true)
                        .setMaxLength(400)
                )
                .addBooleanOption((o) =>
                    o
                        .setName('force')
                        .setDescription(
                            'Also post the newest video even if it was already recorded'
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('transcript')
                .setDescription(
                    'Pull a YouTube transcript and post it in this channel'
                )
                .addStringOption((o) =>
                    o
                        .setName('video')
                        .setDescription('YouTube URL or 11-character video ID')
                        .setRequired(true)
                        .setMaxLength(200)
                )
        ),

    /**
     * @param {import('discord.js').AutocompleteInteraction} interaction
     */
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'channel') {
            await interaction.respond([]);
            return;
        }

        const q = String(focused.value || '').toLowerCase();
        const rows = listSubscriptions(interaction.guildId);
        const choices = rows
            .map((row) => {
                const title = row.yt_channel_title || row.yt_channel_id;
                return {
                    name: title.slice(0, 100),
                    value: row.yt_channel_id,
                };
            })
            .filter(
                (c) =>
                    !q ||
                    c.name.toLowerCase().includes(q) ||
                    c.value.toLowerCase().includes(q)
            )
            .slice(0, 25);

        await interaction.respond(choices);
    },

    /**
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                content: 'Use this command in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'list') {
                const rows = listSubscriptions(guildId);
                const dest = await resolveDiscordChannel(
                    interaction.client,
                    guildId
                );
                const destLine = dest
                    ? `Posts go to ${dest}.`
                    : `No destination yet — create **${feedChannelHint()}** or run \`/ytfeed channel\`.`;

                if (rows.length === 0) {
                    await interaction.reply({
                        content: `Not watching any YouTube channels.\n${destLine}\nAdd one with \`/ytfeed add\`.`,
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const lines = rows.map((row) => {
                    const title = row.yt_channel_title || row.yt_channel_id;
                    return `• **${title}** — \`${row.yt_channel_id}\``;
                });
                await interaction.reply({
                    content: `${destLine}\nPolling about every ${pollMinutes()} minutes.\n\n${lines.join('\n')}`.slice(
                        0,
                        1900
                    ),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'add') {
                requireManageGuild(interaction);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const input = interaction.options.getString('channel', true);
                const result = await addSubscription(
                    guildId,
                    input,
                    interaction.user.id
                );
                const dest = await resolveDiscordChannel(
                    interaction.client,
                    guildId
                );
                const destNote = dest
                    ? `New uploads will be posted in ${dest} within ${pollMinutes()} minutes.`
                    : `Create a **${feedChannelHint()}** channel or run \`/ytfeed channel\` so I know where to post.`;

                if (result.already) {
                    await interaction.editReply(
                        `Already watching **${result.channelTitle}**. ${destNote}`
                    );
                    return;
                }

                await interaction.editReply(
                    `Watching **${result.channelTitle}**. Existing videos were skipped so only new uploads get posted.\n${destNote}`
                );
                return;
            }

            if (sub === 'remove') {
                requireManageGuild(interaction);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const input = interaction.options.getString('channel', true);
                const result = await removeSubscription(guildId, input);
                if (!result.removed) {
                    await interaction.editReply(
                        'That channel is not on the watch list. Use `/ytfeed list` to see current subscriptions.'
                    );
                    return;
                }
                await interaction.editReply(
                    `Stopped watching **${result.channelTitle}**.`
                );
                return;
            }

            if (sub === 'channel') {
                requireManageGuild(interaction);
                const dest =
                    interaction.options.getChannel('destination') ||
                    interaction.channel;
                if (!dest || !dest.isTextBased()) {
                    await interaction.reply({
                        content: 'Pick a text channel to post new videos in.',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                setDiscordChannel(guildId, dest.id);
                await interaction.reply({
                    content: `New YouTube videos will be posted in ${dest}.`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'check') {
                requireManageGuild(interaction);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                if (listSubscriptions(guildId).length === 0) {
                    await interaction.editReply(
                        'Not watching any YouTube channels yet. Use `/ytfeed add`.'
                    );
                    return;
                }

                const result = await inspectAndPost(interaction.client, guildId, {
                    channelInput: interaction.options.getString('channel'),
                    forceLatest: Boolean(interaction.options.getBoolean('force')),
                });

                await interaction.editReply(formatCheckReport(result));
                return;
            }

            if (sub === 'transcript') {
                requireManageGuild(interaction);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const dest = interaction.channel;
                if (!dest || !dest.isTextBased()) {
                    await interaction.editReply(
                        'Run this in a text channel so I can post the transcript.'
                    );
                    return;
                }

                const video = interaction.options.getString('video', true);
                const status = await postTranscriptToChannel(dest, video);
                if (status === 'missing') {
                    await interaction.editReply(
                        `Posted a failure note in ${dest}. No usable captions were found.`
                    );
                    return;
                }
                await interaction.editReply(
                    `Posted the transcript in ${dest} (${status}).`
                );
            }
        } catch (err) {
            const msg = err?.message || String(err);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(msg);
            } else {
                await interaction.reply({
                    content: msg,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
