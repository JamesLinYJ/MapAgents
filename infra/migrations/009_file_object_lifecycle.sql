-- 地理智能平台 - 上传文件结构化生命周期
--
-- PostgreSQL 保存文件资源事实，内容寻址对象存储保存文件字节。
-- request_id 仅在同一线程内幂等；pending 允许进程在发布失败后安全重试。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_file_objects (
  file_id              TEXT PRIMARY KEY,
  workspace_id         TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  session_id           TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  thread_id            TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  created_by_user_id   TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  source_key           TEXT NOT NULL,
  source_relative_path TEXT,
  relative_path        TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  size_bytes           INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type           TEXT NOT NULL,
  request_id           TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'deleted')),
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at             TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_file_objects_thread_request_unique
  ON platform_file_objects (thread_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_file_objects_thread_status_updated
  ON platform_file_objects (thread_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_file_objects_content_hash
  ON platform_file_objects (content_hash);

COMMIT;
