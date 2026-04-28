-- Phase 11 Plan 11-01: chat_sessions + chat_messages for kos-chat Lambda.
--
-- chat_sessions: one row per conversation thread (dashboard or Telegram).
-- chat_messages: ordered messages (user + assistant turns) within a session.
--
-- IAM role `kos_chat` is created separately (see 0031_phase_11_chat_role.sql).
-- Session IDs are ULIDs (26-char uppercase text) — time-sortable, URL-safe.

-- Sessions table.
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id       TEXT        PRIMARY KEY,
  owner_id         UUID        NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
  source           TEXT        NOT NULL CHECK (source IN ('dashboard', 'telegram')),
  -- Stable identifier for the originating thread:
  --   dashboard  → browser-generated key or 'default'
  --   telegram   → string of chat_id (e.g. '123456789')
  external_id      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up active dashboard sessions.
CREATE INDEX IF NOT EXISTS chat_sessions_owner_source_idx
  ON chat_sessions (owner_id, source, last_active_at DESC);

-- Index for Telegram session lookup by chat_id.
CREATE INDEX IF NOT EXISTS chat_sessions_external_id_idx
  ON chat_sessions (owner_id, source, external_id)
  WHERE source = 'telegram';

-- Messages table.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL   PRIMARY KEY,
  session_id  TEXT        NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  owner_id    UUID        NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT        NOT NULL,
  -- seq is the 1-based ordinal within the session (1 = first user msg, 2 = first assistant reply, …).
  -- Monotonically increasing; the upsert CTE in sessions.ts uses MAX(seq)+1 to assign.
  seq         INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx
  ON chat_messages (session_id, seq ASC);
