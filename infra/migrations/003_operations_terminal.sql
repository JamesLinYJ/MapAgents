-- +-------------------------------------------------------------------------
--
--   GeoForge 地理智能平台 - 运维终端与加密录制表
--
--   文件:       003_operations_terminal.sql
--
--   日期:       2026年07月21日
--   作者:       OpenAI Codex
-- --------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS platform_terminal_sessions (
  terminal_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  shell TEXT NOT NULL,
  initial_cols INTEGER NOT NULL,
  initial_rows INTEGER NOT NULL,
  current_cols INTEGER NOT NULL,
  current_rows INTEGER NOT NULL,
  pid INTEGER,
  exit_code INTEGER,
  failure_code TEXT,
  failure_message TEXT,
  key_id TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  key_wrap_nonce TEXT NOT NULL,
  key_wrap_auth_tag TEXT NOT NULL,
  recorded_bytes INTEGER NOT NULL DEFAULT 0,
  last_chunk_sequence INTEGER NOT NULL DEFAULT -1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  detached_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  retained_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_terminal_sessions_state_check
    CHECK (state IN ('starting', 'running', 'detached', 'exited', 'terminated', 'failed', 'orphaned')),
  CONSTRAINT platform_terminal_sessions_cols_check
    CHECK (current_cols BETWEEN 20 AND 400 AND initial_cols BETWEEN 20 AND 400),
  CONSTRAINT platform_terminal_sessions_rows_check
    CHECK (current_rows BETWEEN 5 AND 200 AND initial_rows BETWEEN 5 AND 200),
  CONSTRAINT platform_terminal_sessions_recorded_bytes_check
    CHECK (recorded_bytes >= 0 AND recorded_bytes <= 536870912)
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_owner_state
  ON platform_terminal_sessions(owner_user_id, state);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_retention
  ON platform_terminal_sessions(retained_until);

CREATE TABLE IF NOT EXISTS platform_terminal_transcript_chunks (
  terminal_id TEXT NOT NULL REFERENCES platform_terminal_sessions(terminal_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  first_event_milliseconds INTEGER NOT NULL,
  last_event_milliseconds INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_terminal_transcript_chunks_pk PRIMARY KEY (terminal_id, sequence),
  CONSTRAINT platform_terminal_transcript_chunks_size_check CHECK (size_bytes > 0),
  CONSTRAINT platform_terminal_transcript_chunks_sequence_check CHECK (sequence >= 0),
  CONSTRAINT platform_terminal_transcript_chunks_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_terminal_transcript_chunks_content_hash
  ON platform_terminal_transcript_chunks(content_hash);

CREATE TABLE IF NOT EXISTS platform_terminal_access_grants (
  grant_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES platform_terminal_sessions(terminal_id) ON DELETE CASCADE,
  granted_to_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_terminal_access_grants_reason_check CHECK (char_length(reason) BETWEEN 10 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_terminal_access_grants_grantee_expiry
  ON platform_terminal_access_grants(granted_to_user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_terminal_access_grants_terminal_created
  ON platform_terminal_access_grants(terminal_id, created_at);

COMMIT;
