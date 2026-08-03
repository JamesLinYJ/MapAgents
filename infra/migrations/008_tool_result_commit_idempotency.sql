-- 地理智能平台 - Tool Result 提交幂等键
--
-- Run 状态、Tool Value、Artifact 和 Outbox 在同一个 PostgreSQL 事务中提交。
-- 该表让进程在事务提交后、更新内存投影前崩溃时可以安全重试。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_tool_result_commits (
  run_id     TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  result_id  TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, result_id)
);

COMMIT;
