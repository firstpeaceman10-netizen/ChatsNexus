/**
 * database.js — Chat-Nexus
 *
 * FIXES:
 *  #1  PRAGMA foreign_keys = ON  (SQLite ignores FKs by default — was the crash cause)
 *  #2  System user created BEFORE the default server (fixes FK constraint crash on deploy)
 *  #3  All seed inserts wrapped in a single transaction (atomic — all or nothing)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt   = require('bcryptjs');

const db = new Database(path.join(__dirname, '..', 'chat-nexus.db'));

// ── Performance & correctness pragmas ────────────────────────
db.pragma('journal_mode = WAL');   // better concurrent read performance
db.pragma('foreign_keys = ON');    // FIX #1: enforce FK constraints properly

// ═══════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    tag          TEXT NOT NULL DEFAULT '0000',
    color        TEXT DEFAULT '#00d4ff',
    avatar       TEXT DEFAULT NULL,
    bio          TEXT DEFAULT '',
    premium      INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'online',
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    icon        TEXT DEFAULT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    color       TEXT DEFAULT '#6366f1',
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    role      TEXT DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT DEFAULT 'text',
    description TEXT DEFAULT '',
    position    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL DEFAULT '',
    attachment_url  TEXT DEFAULT NULL,
    attachment_name TEXT DEFAULT NULL,
    edited          INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id          TEXT PRIMARY KEY,
    sender_id   TEXT NOT NULL REFERENCES users(id),
    receiver_id TEXT NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel    ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_users            ON direct_messages(sender_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
`);

// ═══════════════════════════════════════════════════════════════
// SEED DEFAULT SERVER
// FIX #2: system user must exist BEFORE the server row that
//         references it via owner_id FK.
// FIX #3: wrapped in a transaction so partial seeds never occur.
// ═══════════════════════════════════════════════════════════════
const existing = db.prepare(`SELECT id FROM servers WHERE invite_code = 'nexus-hq'`).get();

if (!existing) {
  const seed = db.transaction(() => {
    // 1. Create the system user first
    const systemId = 'system-' + uuidv4();
    const systemHash = bcrypt.hashSync('system-account-not-for-login', 10);
    db.prepare(`
      INSERT INTO users (id, username, display_name, email, password_hash, tag, color, created_at)
      VALUES (?, 'system', 'Chat-Nexus', 'system@chat-nexus.internal', ?, '0000', '#00d4ff', datetime('now'))
    `).run(systemId, systemHash);

    // 2. Now create the default server (owner_id FK satisfied)
    const serverId = uuidv4();
    db.prepare(`
      INSERT INTO servers (id, name, owner_id, invite_code, color, created_at)
      VALUES (?, 'Chat-Nexus HQ', ?, 'nexus-hq', '#00d4ff', datetime('now'))
    `).run(serverId, systemId);

    // 3. Seed default channels
    const channels = [
      { name: 'welcome',       type: 'text',  desc: 'Welcome to Chat-Nexus!', pos: 0 },
      { name: 'general',       type: 'text',  desc: 'General discussion',     pos: 1 },
      { name: 'introductions', type: 'text',  desc: 'Introduce yourself!',    pos: 2 },
      { name: 'off-topic',     type: 'text',  desc: 'Anything goes',          pos: 3 },
      { name: 'memes',         type: 'text',  desc: 'Your best memes',        pos: 4 },
      { name: 'Lounge',        type: 'voice', desc: 'Hang out',               pos: 5 },
      { name: 'Gaming',        type: 'voice', desc: 'Game together',          pos: 6 },
    ];

    const insertChannel = db.prepare(`
      INSERT INTO channels (id, server_id, name, type, description, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    channels.forEach(ch => insertChannel.run(uuidv4(), serverId, ch.name, ch.type, ch.desc, ch.pos));

    console.log('✅ Default server "Chat-Nexus HQ" seeded (invite: nexus-hq)');
  });

  seed();
}

module.exports = db;
