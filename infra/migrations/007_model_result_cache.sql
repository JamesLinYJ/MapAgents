-- 地理智能平台 - 模型结果缓存持久化表
--
-- 缓存是可丢弃的辅助数据，不参与 Run/Thread 恢复；结构仍由 migration 管理，
-- 不允许应用启动时通过 runtime DDL 竞争 schema 事实源。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_model_result_cache (
  cache_key        TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  content          TEXT NOT NULL,
  usage_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_model_result_cache_hit_count_check CHECK (hit_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_model_result_cache_workspace_expiry
  ON platform_model_result_cache (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_model_result_cache_expiry
  ON platform_model_result_cache (expires_at);

COMMIT;
