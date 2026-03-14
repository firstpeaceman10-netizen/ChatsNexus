-- ============================================================
-- Nexus Chat - Full Database Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fast text search

-- ─── USERS ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT,
  banner_url    TEXT,
  bio           TEXT DEFAULT '',
  status        TEXT DEFAULT 'online' CHECK (status IN ('online','idle','dnd','invisible','offline')),
  custom_status TEXT DEFAULT '',
  plan          TEXT DEFAULT 'free' CHECK (plan IN ('free','pro')),
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan_expires_at TIMESTAMPTZ,
  email_verified  BOOLEAN DEFAULT FALSE,
  mfa_enabled     BOOLEAN DEFAULT FALSE,
  mfa_secret      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email    ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_username_trgm ON users USING gin(username gin_trgm_ops);

-- ─── REFRESH TOKENS ───────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token  ON refresh_tokens(token);

-- ─── SERVERS ──────────────────────────────────────────────────────────────
CREATE TABLE servers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  icon_url     TEXT,
  banner_url   TEXT,
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code  TEXT UNIQUE NOT NULL DEFAULT substring(md5(random()::text) from 1 for 8),
  is_public    BOOLEAN DEFAULT FALSE,
  member_count INT DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_servers_owner      ON servers(owner_id);
CREATE INDEX idx_servers_invite     ON servers(invite_code);
CREATE INDEX idx_servers_public     ON servers(is_public) WHERE is_public = TRUE;
CREATE INDEX idx_servers_name_trgm  ON servers USING gin(name gin_trgm_ops);

-- ─── SERVER MEMBERS ───────────────────────────────────────────────────────
CREATE TABLE server_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT DEFAULT 'member' CHECK (role IN ('owner','admin','moderator','member')),
  nickname  TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (server_id, user_id)
);

CREATE INDEX idx_server_members_server ON server_members(server_id);
CREATE INDEX idx_server_members_user   ON server_members(user_id);

-- ─── ROLES ────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT DEFAULT '#99aab5',
  position    INT DEFAULT 0,
  permissions BIGINT DEFAULT 0, -- bitfield
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CHANNELS ─────────────────────────────────────────────────────────────
CREATE TABLE channels (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'text' CHECK (type IN ('text','voice','announcement','stage')),
  position    INT DEFAULT 0,
  category    TEXT DEFAULT 'general',
  is_nsfw     BOOLEAN DEFAULT FALSE,
  slowmode_seconds INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_channels_server ON channels(server_id);

-- ─── MESSAGES ─────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id    UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  content      TEXT NOT NULL DEFAULT '',
  type         TEXT DEFAULT 'default' CHECK (type IN ('default','system','reply','thread_start')),
  reply_to_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  edited_at    TIMESTAMPTZ,
  is_pinned    BOOLEAN DEFAULT FALSE,
  attachments  JSONB DEFAULT '[]'::jsonb,
  embeds       JSONB DEFAULT '[]'::jsonb,
  mentions     UUID[] DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_channel    ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_author     ON messages(author_id);
CREATE INDEX idx_messages_reply_to   ON messages(reply_to_id);
CREATE INDEX idx_messages_pinned     ON messages(channel_id) WHERE is_pinned = TRUE;
CREATE INDEX idx_messages_content_trgm ON messages USING gin(content gin_trgm_ops);

-- ─── REACTIONS ────────────────────────────────────────────────────────────
CREATE TABLE reactions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON reactions(message_id);

-- ─── DIRECT MESSAGES ──────────────────────────────────────────────────────
CREATE TABLE dm_channels (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE dm_participants (
  dm_channel_id UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (dm_channel_id, user_id)
);

CREATE TABLE dm_messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dm_channel_id UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  content       TEXT NOT NULL DEFAULT '',
  attachments   JSONB DEFAULT '[]'::jsonb,
  reply_to_id   UUID REFERENCES dm_messages(id),
  edited_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dm_messages_channel ON dm_messages(dm_channel_id, created_at DESC);

-- ─── FRIENDS ──────────────────────────────────────────────────────────────
CREATE TABLE friendships (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','blocked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, friend_id)
);

CREATE INDEX idx_friendships_user   ON friendships(user_id);
CREATE INDEX idx_friendships_friend ON friendships(friend_id);

-- ─── USER SETTINGS ────────────────────────────────────────────────────────
CREATE TABLE user_settings (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme             TEXT DEFAULT 'dark',
  locale            TEXT DEFAULT 'en-US',
  notifications     JSONB DEFAULT '{"mentions":true,"dms":true,"sounds":true}'::jsonb,
  accessibility     JSONB DEFAULT '{}'::jsonb,
  message_display   TEXT DEFAULT 'cozy' CHECK (message_display IN ('cozy','compact')),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AUDIT LOG ────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  server_id   UUID REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  changes     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_server ON audit_logs(server_id, created_at DESC);

-- ─── AUTO-UPDATE TIMESTAMPS ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_servers_updated_at
  BEFORE UPDATE ON servers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_channels_updated_at
  BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── UPDATE MEMBER COUNT ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_server_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE servers SET member_count = member_count + 1 WHERE id = NEW.server_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE servers SET member_count = GREATEST(member_count - 1, 0) WHERE id = OLD.server_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_server_member_count
  AFTER INSERT OR DELETE ON server_members
  FOR EACH ROW EXECUTE FUNCTION update_server_member_count();

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────
-- Using Supabase service key from backend, so RLS is bypassed server-side.
-- Enable RLS if you want to allow direct client-to-Supabase connections.
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- (Add policies as needed if you go direct-to-Supabase)
