const { ChannelType, PermissionsBitField } = require('discord.js');
const db = require('../storage/db');
const config = require('../config');
const { logError, logWarn } = require('../utils/errorLog');
const youtubeRss = require('./youtubeRss');
const {
    YT_CHANNEL_ID_RE,
    fetchChannelFeed,
    resolveChannelId,
    formatNewVideoMessage,
} = youtubeRss;

const DEFAULT_CHANNEL_NAME = 'youtube-feed';
const SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const insertSubscription = db.prepare(`
    INSERT INTO youtube_feed_subscriptions (
        guild_id, yt_channel_id, yt_channel_title, added_by, created_at
    ) VALUES (@guildId, @ytChannelId, @ytChannelTitle, @addedBy, @now)
`);

const updateSubscriptionTitle = db.prepare(`
    UPDATE youtube_feed_subscriptions
    SET yt_channel_title = @ytChannelTitle
    WHERE guild_id = @guildId AND yt_channel_id = @ytChannelId
`);

const deleteSubscriptionStmt = db.prepare(`
    DELETE FROM youtube_feed_subscriptions
    WHERE guild_id = ? AND yt_channel_id = ?
`);

const selectSubscriptionsForGuild = db.prepare(`
    SELECT guild_id, yt_channel_id, yt_channel_title, added_by, created_at
    FROM youtube_feed_subscriptions
    WHERE guild_id = ?
    ORDER BY yt_channel_title COLLATE NOCASE ASC, yt_channel_id ASC
`);

const selectAllSubscriptions = db.prepare(`
    SELECT guild_id, yt_channel_id, yt_channel_title, added_by, created_at
    FROM youtube_feed_subscriptions
    ORDER BY guild_id ASC, yt_channel_title COLLATE NOCASE ASC
`);

const selectSubscription = db.prepare(`
    SELECT guild_id, yt_channel_id, yt_channel_title, added_by, created_at
    FROM youtube_feed_subscriptions
    WHERE guild_id = ? AND yt_channel_id = ?
`);

const upsertSettings = db.prepare(`
    INSERT INTO youtube_feed_settings (guild_id, discord_channel_id, updated_at)
    VALUES (@guildId, @discordChannelId, @now)
    ON CONFLICT(guild_id) DO UPDATE SET
        discord_channel_id = excluded.discord_channel_id,
        updated_at = excluded.updated_at
`);

const selectSettings = db.prepare(`
    SELECT discord_channel_id FROM youtube_feed_settings WHERE guild_id = ?
`);

const insertSeen = db.prepare(`
    INSERT OR IGNORE INTO youtube_feed_seen (
        guild_id, video_id, yt_channel_id, published_at, posted_at
    ) VALUES (@guildId, @videoId, @ytChannelId, @publishedAt, @now)
`);

const isSeenStmt = db.prepare(`
    SELECT 1 FROM youtube_feed_seen WHERE guild_id = ? AND video_id = ?
`);

const deleteSeenForChannel = db.prepare(`
    DELETE FROM youtube_feed_seen WHERE guild_id = ? AND yt_channel_id = ?
`);

const pruneSeenStmt = db.prepare(`
    DELETE FROM youtube_feed_seen WHERE posted_at < ?
`);

/** @type {NodeJS.Timeout | null} */
let pollTimer = null;
let inFlight = false;
/** @type {Set<string>} */
const pollFailNotified = new Set();

/**
 * @param {string} guildId
 * @param {string} ytChannelId
 * @param {Array<{ videoId: string, publishedMs: number }>} entries
 */
function markSeen(guildId, ytChannelId, entries) {
    const now = Date.now();
    const tx = db.transaction(() => {
        for (const entry of entries) {
            insertSeen.run({
                guildId,
                videoId: entry.videoId,
                ytChannelId,
                publishedAt: entry.publishedMs || null,
                now,
            });
        }
    });
    tx();
}

/**
 * @param {string} guildId
 * @param {string} videoId
 * @returns {boolean}
 */
function hasSeen(guildId, videoId) {
    return Boolean(isSeenStmt.get(guildId, videoId));
}

/**
 * @param {string} guildId
 * @returns {{ discord_channel_id: string | null } | undefined}
 */
function getSettings(guildId) {
    return selectSettings.get(guildId);
}

/**
 * @param {string} guildId
 * @param {string} discordChannelId
 */
function setDiscordChannel(guildId, discordChannelId) {
    upsertSettings.run({
        guildId,
        discordChannelId,
        now: Date.now(),
    });
}

/**
 * @param {string} guildId
 */
function listSubscriptions(guildId) {
    return selectSubscriptionsForGuild.all(guildId);
}

/**
 * @param {import('discord.js').Guild} guild
 * @returns {import('discord.js').GuildTextBasedChannel | null}
 */
function findNamedFeedChannel(guild) {
    const wanted = (
        config.youtubeFeedChannelName || DEFAULT_CHANNEL_NAME
    ).toLowerCase();
    const match = guild.channels.cache.find(
        (ch) =>
            ch &&
            typeof ch.isTextBased === 'function' &&
            ch.isTextBased() &&
            !ch.isVoiceBased?.() &&
            ch.name?.toLowerCase() === wanted &&
            (ch.type === ChannelType.GuildText ||
                ch.type === ChannelType.GuildAnnouncement)
    );
    return match || null;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {Promise<import('discord.js').GuildTextBasedChannel | null>}
 */
async function resolveDiscordChannel(client, guildId) {
    const guild = client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
        return null;
    }

    if (guild.channels.cache.size === 0) {
        await guild.channels.fetch().catch(() => null);
    }

    const settings = getSettings(guildId);
    if (settings?.discord_channel_id) {
        const configured =
            guild.channels.cache.get(settings.discord_channel_id) ||
            (await guild.channels
                .fetch(settings.discord_channel_id)
                .catch(() => null));
        if (configured && configured.isTextBased()) {
            return configured;
        }
    }

    return findNamedFeedChannel(guild);
}

/**
 * @param {import('discord.js').GuildTextBasedChannel} channel
 * @returns {boolean}
 */
function canSend(channel) {
    const me = channel.guild.members.me;
    if (!me) {
        return true;
    }
    const perms = channel.permissionsFor(me);
    if (!perms) {
        return true;
    }
    return perms.has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
    ]);
}

/**
 * @param {string} guildId
 * @param {string} input
 * @param {string} addedBy
 * @returns {Promise<{ added: boolean, already: boolean, channelId: string, channelTitle: string, entryCount: number }>}
 */
async function addSubscription(guildId, input, addedBy) {
    const channelId = await resolveChannelId(input);
    const existing = selectSubscription.get(guildId, channelId);
    const feed = await fetchChannelFeed(channelId);
    const title = feed.channelTitle || existing?.yt_channel_title || channelId;

    if (existing) {
        if (title && title !== existing.yt_channel_title) {
            updateSubscriptionTitle.run({
                guildId,
                ytChannelId: channelId,
                ytChannelTitle: title,
            });
        }
        markSeen(guildId, channelId, feed.entries);
        return {
            added: false,
            already: true,
            channelId,
            channelTitle: title,
            entryCount: feed.entries.length,
        };
    }

    const now = Date.now();
    const commit = db.transaction(() => {
        insertSubscription.run({
            guildId,
            ytChannelId: channelId,
            ytChannelTitle: title,
            addedBy: addedBy || null,
            now,
        });
        for (const entry of feed.entries) {
            insertSeen.run({
                guildId,
                videoId: entry.videoId,
                ytChannelId: channelId,
                publishedAt: entry.publishedMs || null,
                now,
            });
        }
    });

    try {
        commit();
    } catch (err) {
        if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
            markSeen(guildId, channelId, feed.entries);
            return {
                added: false,
                already: true,
                channelId,
                channelTitle: title,
                entryCount: feed.entries.length,
            };
        }
        throw err;
    }

    return {
        added: true,
        already: false,
        channelId,
        channelTitle: title,
        entryCount: feed.entries.length,
    };
}

/**
 * Match remove input against a subscription (id, title, handle-ish).
 * @param {string} guildId
 * @param {string} input
 * @returns {Promise<{ removed: boolean, channelId: string | null, channelTitle: string | null }>}
 */
async function removeSubscription(guildId, input) {
    const raw = String(input || '').trim();
    const subs = listSubscriptions(guildId);
    if (subs.length === 0) {
        return { removed: false, channelId: null, channelTitle: null };
    }

    let channelId = null;
    if (YT_CHANNEL_ID_RE.test(raw)) {
        channelId = raw;
    } else {
        const lowered = raw.replace(/^@/, '').toLowerCase();
        const byTitle = subs.find(
            (s) =>
                (s.yt_channel_title || '').toLowerCase() === lowered ||
                (s.yt_channel_title || '').toLowerCase() === raw.toLowerCase()
        );
        if (byTitle) {
            channelId = byTitle.yt_channel_id;
        } else {
            try {
                channelId = await resolveChannelId(raw);
            } catch {
                channelId = null;
            }
        }
    }

    if (!channelId) {
        return { removed: false, channelId: null, channelTitle: null };
    }

    const row = selectSubscription.get(guildId, channelId);
    if (!row) {
        return { removed: false, channelId, channelTitle: null };
    }

    deleteSubscriptionStmt.run(guildId, channelId);
    deleteSeenForChannel.run(guildId, channelId);
    return {
        removed: true,
        channelId,
        channelTitle: row.yt_channel_title || channelId,
    };
}

/**
 * @param {string} guildId
 * @param {{ yt_channel_id: string, yt_channel_title: string | null }} sub
 * @param {import('discord.js').GuildTextBasedChannel | null} dest
 * @returns {Promise<number>}
 */
async function pollSubscription(guildId, sub, dest) {
    const feed = await fetchChannelFeed(sub.yt_channel_id);
    if (feed.channelTitle && feed.channelTitle !== sub.yt_channel_title) {
        updateSubscriptionTitle.run({
            guildId,
            ytChannelId: sub.yt_channel_id,
            ytChannelTitle: feed.channelTitle,
        });
        sub.yt_channel_title = feed.channelTitle;
    }

    const fresh = feed.entries.filter((entry) => !hasSeen(guildId, entry.videoId));
    if (fresh.length === 0) {
        return 0;
    }

    if (!dest) {
        logWarn(
            'youtubeFeed',
            `No #${config.youtubeFeedChannelName || DEFAULT_CHANNEL_NAME} channel for guild ${guildId}; ${fresh.length} new video(s) waiting`
        );
        return 0;
    }

    if (!canSend(dest)) {
        logWarn(
            'youtubeFeed',
            `Missing Send Messages in #${dest.name} (${dest.id}) for guild ${guildId}`
        );
        return 0;
    }

    let posted = 0;
    const channelName = feed.channelTitle || sub.yt_channel_title || 'YouTube';
    for (const entry of fresh) {
        try {
            await dest.send({
                content: formatNewVideoMessage(channelName, entry.videoId),
                allowedMentions: { parse: [] },
            });
            insertSeen.run({
                guildId,
                videoId: entry.videoId,
                ytChannelId: sub.yt_channel_id,
                publishedAt: entry.publishedMs || null,
                now: Date.now(),
            });
            posted += 1;
        } catch (err) {
            logError('youtubeFeed.post', err, {
                guildId,
                channelId: dest.id,
                videoId: entry.videoId,
            });
            break;
        }
    }
    return posted;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} [onlyGuildId]
 * @returns {Promise<{ subscriptions: number, posted: number, errors: number }>}
 */
async function runPoll(client, onlyGuildId) {
    const rows = onlyGuildId
        ? selectSubscriptionsForGuild.all(onlyGuildId)
        : selectAllSubscriptions.all();

    if (rows.length === 0) {
        return { subscriptions: 0, posted: 0, errors: 0 };
    }

    /** @type {Map<string, import('discord.js').GuildTextBasedChannel | null>} */
    const destCache = new Map();
    let posted = 0;
    let errors = 0;

    for (const sub of rows) {
        let dest;
        if (destCache.has(sub.guild_id)) {
            dest = destCache.get(sub.guild_id);
        } else {
            dest = await resolveDiscordChannel(client, sub.guild_id);
            destCache.set(sub.guild_id, dest);
        }

        try {
            posted += await pollSubscription(sub.guild_id, sub, dest || null);
            pollFailNotified.delete(`${sub.guild_id}:${sub.yt_channel_id}`);
        } catch (err) {
            errors += 1;
            const key = `${sub.guild_id}:${sub.yt_channel_id}`;
            if (!pollFailNotified.has(key)) {
                pollFailNotified.add(key);
                logWarn(
                    'youtubeFeed.poll',
                    `${sub.yt_channel_title || sub.yt_channel_id}: ${err.message || err}`
                );
            }
        }
    }

    try {
        pruneSeenStmt.run(Date.now() - SEEN_RETENTION_MS);
    } catch (err) {
        logWarn('youtubeFeed.prune', err);
    }

    return { subscriptions: rows.length, posted, errors };
}

let pollQueue = Promise.resolve();

/**
 * @param {import('discord.js').Client} client
 * @param {string} [onlyGuildId]
 * @returns {Promise<{ subscriptions: number, posted: number, errors: number }>}
 */
function pollAll(client, onlyGuildId) {
    const scheduled = pollQueue.then(() => runPoll(client, onlyGuildId));
    pollQueue = scheduled.then(
        () => undefined,
        (err) => {
            logError('youtubeFeed.pollAll', err);
        }
    );
    return scheduled;
}

/**
 * @param {import('discord.js').Client} client
 */
function startYoutubeFeed(client) {
    if (pollTimer) {
        return;
    }

    const intervalMs = Number(config.youtubeFeedPollMs) || 5 * 60 * 1000;

    const tick = async () => {
        if (inFlight) {
            return;
        }
        inFlight = true;
        try {
            const result = await pollAll(client);
            if (result.posted > 0) {
                console.log(
                    `[youtubeFeed] posted ${result.posted} new video(s) from ${result.subscriptions} channel(s)`
                );
            }
        } catch (err) {
            logError('youtubeFeed.tick', err);
        } finally {
            inFlight = false;
        }
    };

    const firstDelay = Math.min(12_000, intervalMs);
    setTimeout(() => {
        tick();
    }, firstDelay);
    pollTimer = setInterval(tick, intervalMs);
    if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
    }

    console.log(
        `[youtubeFeed] polling every ${Math.round(intervalMs / 1000)}s; posts go to #${config.youtubeFeedChannelName || DEFAULT_CHANNEL_NAME} unless /ytfeed channel is set`
    );
}

module.exports = {
    ...youtubeRss,
    addSubscription,
    removeSubscription,
    listSubscriptions,
    getSettings,
    setDiscordChannel,
    resolveDiscordChannel,
    startYoutubeFeed,
    pollAll,
};
