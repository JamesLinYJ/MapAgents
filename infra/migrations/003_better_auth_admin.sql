-- +-------------------------------------------------------------------------
--
--   GeoForge 地理智能平台 - Better Auth Admin Plugin Schema
--
--   文件:       003_better_auth_admin.sql
--
--   日期:       2026年07月21日
--   作者:       OpenAI Codex
-- --------------------------------------------------------------------------

BEGIN;

ALTER TABLE auth_user
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ban_reason TEXT,
  ADD COLUMN IF NOT EXISTS ban_expires TIMESTAMPTZ;

ALTER TABLE auth_session
  ADD COLUMN IF NOT EXISTS impersonated_by TEXT;

COMMIT;
