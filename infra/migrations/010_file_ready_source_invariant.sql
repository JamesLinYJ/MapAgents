-- 地理智能平台 - 同一线程来源只保留一个 ready 文件版本
--
-- ready/retire 由应用事务串行提交；部分唯一索引是数据库最终不变量。

BEGIN;

-- 009 的旧提交流程可能在 markReady 后、retire 前崩溃。升级时按提交时间
-- 确定性保留最新版本，避免唯一索引把可修复的历史中间态变成升级阻塞。
WITH ranked_ready AS (
  SELECT
    file_id,
    ROW_NUMBER() OVER (
      PARTITION BY thread_id, source_key
      ORDER BY ready_at DESC NULLS LAST, updated_at DESC, file_id DESC
    ) AS version_rank
  FROM platform_file_objects
  WHERE status = 'ready'
)
UPDATE platform_file_objects AS files
SET
  status = 'deleted',
  deleted_at = COALESCE(files.deleted_at, NOW()),
  updated_at = NOW()
FROM ranked_ready
WHERE files.file_id = ranked_ready.file_id
  AND ranked_ready.version_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_file_objects_thread_source_ready_unique
  ON platform_file_objects (thread_id, source_key)
  WHERE status = 'ready';

COMMIT;
