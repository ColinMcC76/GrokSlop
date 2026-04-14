const db = require('../storage/db');
const config = require('../config');

function saveMessage(message) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO messages (
            id, guild_id, channel_id, user_id, username, content, is_bot, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
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
    const stmt = db.prepare(`
        SELECT username, content, is_bot, created_at
        FROM messages
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `);

    return stmt.all(channelId, limit).reverse();
}

function getGuildMemory(guildId, limit = config.guildMemoryLimit) {
    const stmt = db.prepare(`
        SELECT key, value, weight, updated_at
        FROM guild_memory
        WHERE guild_id = ?
        ORDER BY weight DESC, updated_at DESC
        LIMIT ?
    `);

    return stmt.all(guildId, limit);
}

function getUserMemory(guildId, userId, limit = config.userMemoryLimit) {
    const stmt = db.prepare(`
        SELECT key, value, weight, updated_at
        FROM user_memory
        WHERE guild_id = ? AND user_id = ?
        ORDER BY weight DESC, updated_at DESC
        LIMIT ?
    `);

    return stmt.all(guildId, userId, limit);
}

function upsertGuildMemory(guildId, key, value, weight = 1) {
    const now = Date.now();

    const existing = db.prepare(`
        SELECT id FROM guild_memory
        WHERE guild_id = ? AND key = ?
    `).get(guildId, key);

    if (existing) {
        db.prepare(`
            UPDATE guild_memory
            SET value = ?, weight = ?, updated_at = ?
            WHERE id = ?
        `).run(value, weight, now, existing.id);
    } else {
        db.prepare(`
            INSERT INTO guild_memory (guild_id, key, value, weight, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(guildId, key, value, weight, now, now);
    }
}

function upsertUserMemory(guildId, userId, key, value, weight = 1) {
    const now = Date.now();

    const existing = db.prepare(`
        SELECT id FROM user_memory
        WHERE guild_id = ? AND user_id = ? AND key = ?
    `).get(guildId, userId, key);

    if (existing) {
        db.prepare(`
            UPDATE user_memory
            SET value = ?, weight = ?, updated_at = ?
            WHERE id = ?
        `).run(value, weight, now, existing.id);
    } else {
        db.prepare(`
            INSERT INTO user_memory (guild_id, user_id, key, value, weight, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(guildId, userId, key, value, weight, now, now);
    }
}

function deleteGuildMemory(guildId, key) {
    const info = db.prepare(`
        DELETE FROM guild_memory
        WHERE guild_id = ? AND key = ?
    `).run(guildId, key);
    return info.changes;
}

function deleteUserMemory(guildId, userId, key) {
    const info = db.prepare(`
        DELETE FROM user_memory
        WHERE guild_id = ? AND user_id = ? AND key = ?
    `).run(guildId, userId, key);
    return info.changes;
}

module.exports = {
    saveMessage,
    getRecentMessages,
    getGuildMemory,
    getUserMemory,
    upsertGuildMemory,
    upsertUserMemory,
    deleteGuildMemory,
    deleteUserMemory
};