const db = require('../storage/db');
const { getConnectionData, joinChannel } = require('./voiceManager');
const {
    enqueueIntro,
    enqueueIntroTrack,
    resolveSingleTrack,
} = require('./youtubeQueue');
const { isRealtimeActive } = require('./realtimeVoiceBridge');
const { isActive: isSpotifySpeakerActive } = require('./spotifyConnect');

const INTRO_COOLDOWN_MS = 90_000;

/** @type {Map<string, number>} guildId:userId -> last played ms */
const recentIntroByMember = new Map();

const selectIntro = db.prepare(`
    SELECT user_id, query, title, updated_at
    FROM user_intro_songs
    WHERE user_id = ?
`);

const upsertIntro = db.prepare(`
    INSERT INTO user_intro_songs (user_id, query, title, updated_at)
    VALUES (@userId, @query, @title, @updatedAt)
    ON CONFLICT(user_id) DO UPDATE SET
        query = excluded.query,
        title = excluded.title,
        updated_at = excluded.updated_at
`);

const deleteIntro = db.prepare(`
    DELETE FROM user_intro_songs WHERE user_id = ?
`);

/**
 * @param {string} userId
 */
function getIntroSong(userId) {
    return selectIntro.get(userId) || null;
}

/**
 * @param {string} userId
 * @param {string} query
 * @param {string | null} [title]
 */
function saveIntroSong(userId, query, title = null) {
    upsertIntro.run({
        userId,
        query: query.trim(),
        title: title || null,
        updatedAt: Date.now(),
    });
    return getIntroSong(userId);
}

/**
 * @param {string} userId
 */
function clearIntroSong(userId) {
    deleteIntro.run(userId);
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function isIntroOnCooldown(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const last = recentIntroByMember.get(key);
    if (!last) {
        return false;
    }
    return Date.now() - last < INTRO_COOLDOWN_MS;
}

/**
 * @param {string} guildId
 * @param {string} userId
 */
function markIntroPlayed(guildId, userId) {
    recentIntroByMember.set(`${guildId}:${userId}`, Date.now());
}

/**
 * @param {string} guildId
 */
function canUseYoutubePlayback(guildId) {
    if (isRealtimeActive(guildId)) {
        return {
            ok: false,
            reason: 'Turn off realtime voice (/talkoff) before intro songs.',
        };
    }
    if (isSpotifySpeakerActive(guildId)) {
        return {
            ok: false,
            reason:
                'Spotify Connect is using the voice speaker. Stop Spotify playback first.',
        };
    }
    return { ok: true };
}

/**
 * @param {import('discord.js').GuildMember} member
 */
async function ensureVoiceForMember(member) {
    const guildId = member.guild.id;
    let connectionData = getConnectionData(guildId);
    if (connectionData) {
        return connectionData;
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
        throw new Error('Join a voice channel first.');
    }

    return joinChannel(voiceChannel);
}

/**
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextBasedChannel | null} textChannel
 * @param {string} query
 */
async function saveAndPlayIntro(member, textChannel, query) {
    const gate = canUseYoutubePlayback(member.guild.id);
    if (!gate.ok) {
        throw new Error(gate.reason);
    }

    const track = await resolveSingleTrack(query);
    saveIntroSong(member.id, query.trim(), track.title);

    const { player } = await ensureVoiceForMember(member);
    const { title } = await enqueueIntro(
        member.guild.id,
        player,
        textChannel,
        query,
        { displayName: member.displayName }
    );

    markIntroPlayed(member.guild.id, member.id);
    return { title, query: query.trim() };
}

/**
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextBasedChannel | null} textChannel
 */
async function playStoredIntro(member, textChannel) {
    const row = getIntroSong(member.id);
    if (!row) {
        throw new Error(
            'You do not have an intro song saved. Use `/introsong` with a YouTube link or search.'
        );
    }

    const gate = canUseYoutubePlayback(member.guild.id);
    if (!gate.ok) {
        throw new Error(gate.reason);
    }

    const track = await resolveSingleTrack(row.query);
    if (track.title && track.title !== row.title) {
        saveIntroSong(member.id, row.query, track.title);
    }

    const { player } = await ensureVoiceForMember(member);
    const { title } = enqueueIntroTrack(
        member.guild.id,
        player,
        textChannel,
        track,
        { displayName: member.displayName }
    );

    markIntroPlayed(member.guild.id, member.id);
    return { title, query: row.query };
}

/**
 * @param {string} guildId
 * @param {import('discord.js').GuildMember} member
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
async function tryPlayIntroOnJoin(guildId, member, player) {
    if (member.user.bot) {
        return;
    }

    const row = getIntroSong(member.id);
    if (!row) {
        return;
    }

    if (isIntroOnCooldown(guildId, member.id)) {
        return;
    }

    const gate = canUseYoutubePlayback(guildId);
    if (!gate.ok) {
        return;
    }

    try {
        const track = await resolveSingleTrack(row.query);
        enqueueIntroTrack(guildId, player, null, track, {
            displayName: member.displayName,
        });
        markIntroPlayed(guildId, member.id);
        console.log(
            `[intro] auto-play for ${member.displayName} in guild ${guildId}: ${track.title}`
        );
    } catch (err) {
        console.warn(
            `[intro] auto-play failed for ${member.id}:`,
            err?.message || err
        );
    }
}

module.exports = {
    getIntroSong,
    saveIntroSong,
    clearIntroSong,
    saveAndPlayIntro,
    playStoredIntro,
    tryPlayIntroOnJoin,
    INTRO_COOLDOWN_MS,
};
