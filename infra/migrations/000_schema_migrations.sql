-- 地理智能平台 - 不可变 migration ledger
--
-- 该文件是所有数据库迁移的 bootstrap。它只建立迁移记录表，不包含业务表。
-- 迁移执行器在每个脚本成功后写入 checksum；脚本一旦被应用，内容不得修改。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  migration_id       TEXT PRIMARY KEY,
  checksum            TEXT,
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  application_release TEXT
);

ALTER TABLE platform_schema_migrations
  ADD COLUMN IF NOT EXISTS checksum TEXT;
ALTER TABLE platform_schema_migrations
  ADD COLUMN IF NOT EXISTS application_release TEXT;

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON platform_schema_migrations (applied_at);

COMMIT;
