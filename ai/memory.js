const db = require('../storage/db');
const config = require('../config');

const insertMessage = db.prepare(`
    INSERT OR REPLACE INTO messages (
        id, guild_id, channel_id, user_id, username, content, is_bot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectRecentMessages = db.prepare(`
    SELECT username, content, is_bot, created_at
    FROM messages
    WHERE channel_id = ?
    ORDER BY created_at DESC
    LIMIT ?
`);

const selectGuildMemory = db.prepare(`
    SELECT key, value, weight, updated_at
    FROM guild_memory
    WHERE guild_id = ?
    ORDER BY weight DESC, updated_at DESC
    LIMIT ?
`);

const selectUserMemory = db.prepare(`
    SELECT key, value, weight, updated_at
    FROM user_memory
    WHERE guild_id = ? AND user_id = ?
    ORDER BY weight DESC, updated_at DESC
    LIMIT ?
`);

const upsertGuildMemoryStmt = db.prepare(`
    INSERT INTO guild_memory (guild_id, key, value, weight, created_at, updated_at)
    VALUES (@guildId, @key, @value, @weight, @now, @now)
    ON CONFLICT(guild_id, key) DO UPDATE SET
        value = excluded.value,
        weight = excluded.weight,
        updated_at = excluded.updated_at
`);

const upsertUserMemoryStmt = db.prepare(`
    INSERT INTO user_memory (guild_id, user_id, key, value, weight, created_at, updated_at)
    VALUES (@guildId, @userId, @key, @value, @weight, @now, @now)
    ON CONFLICT(guild_id, user_id, key) DO UPDATE SET
        value = excluded.value,
        weight = excluded.weight,
        updated_at = excluded.updated_at
`);

function saveMessage(message) {
    insertMessage.run(
        message.id,
        message.guildId,
        message.channelId,
        message.userId,
        message.username,
        message.content || '',
        message.isBot ? 1 : 0,
        message.createdAt
    );
}

function getRecentMessages(channelId, limit = config.recentMessageLimit) {
    return selectRecentMessages.all(channelId, limit).reverse();
}

function getGuildMemory(guildId, limit = config.guildMemoryLimit) {
    return selectGuildMemory.all(guildId, limit);
}

function getUserMemory(guildId, userId, limit = config.userMemoryLimit) {
    return selectUserMemory.all(guildId, userId, limit);
}

function upsertGuildMemory(guildId, key, value, weight = 1) {
    const now = Date.now();
    upsertGuildMemoryStmt.run({ guildId, key, value, weight, now });
}

function upsertUserMemory(guildId, userId, key, value, weight = 1) {
    const now = Date.now();
    upsertUserMemoryStmt.run({ guildId, userId, key, value, weight, now });
}

module.exports = {
    saveMessage,
    getRecentMessages,
    getGuildMemory,
    getUserMemory,
    upsertGuildMemory,
    upsertUserMemory
};
