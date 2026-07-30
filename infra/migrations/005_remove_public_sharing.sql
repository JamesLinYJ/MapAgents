-- GeoForge 桌面工作台公开分享移除迁移
-- 日期: 2026年07月29日
-- 作者: OpenAI Codex
--
-- 公开 URL 不再是产品能力。迁移只删除公开分享定位字段和唯一索引；
-- 会话、线程、运行、对话、图层及 Artifact 内容保持不变。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP INDEX IF EXISTS idx_platform_sessions_share_token_unique;
ALTER TABLE platform_sessions DROP COLUMN IF EXISTS share_token;

INSERT INTO platform_schema_migrations (migration_id)
VALUES ('005_remove_public_sharing')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
