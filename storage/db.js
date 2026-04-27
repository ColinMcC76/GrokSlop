const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'grokbot.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    guild_id TEXT,
    channel_id TEXT,
    user_id TEXT,
    username TEXT,
    content TEXT,
    is_bot INTEGER DEFAULT 0,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS guild_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    weight INTEGER DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    weight INTEGER DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
);
`);

function migrate() {
    db.exec(`
        DELETE FROM guild_memory
        WHERE id IN (
            SELECT o.id FROM guild_memory o
            INNER JOIN (
                SELECT guild_id, key, MAX(id) AS keep_id FROM guild_memory GROUP BY guild_id, key
            ) k ON o.guild_id = k.guild_id AND o.key = k.key AND o.id != k.keep_id
        );

        DELETE FROM user_memory
        WHERE id IN (
            SELECT o.id FROM user_memory o
            INNER JOIN (
                SELECT guild_id, user_id, key, MAX(id) AS keep_id
                FROM user_memory GROUP BY guild_id, user_id, key
            ) k ON o.guild_id = k.guild_id AND o.user_id = k.user_id AND o.key = k.key AND o.id != k.keep_id
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_memory_guild_key ON guild_memory(guild_id, key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memory_guild_user_key ON user_memory(guild_id, user_id, key);
        CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS guild_personas (
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, name)
        );

        CREATE TABLE IF NOT EXISTS guild_persona_selection (
            guild_id TEXT PRIMARY KEY,
            persona_name TEXT
        );
    `);
}

migrate();

module.exports = db;
