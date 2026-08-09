-- 地理智能平台 - Run input checkpoint delivery acknowledgement
--
-- 每个 Run 以单调 input sequence/cursor 表达“哪些输入已进入 SDK checkpoint”。
-- 输入先 lease，只有在 checkpoint hash 引用持久化的同一事务中才 ack。
-- 所有 DDL 都可在“脚本已提交、migration ledger 尚未写入”的崩溃窗口后重跑。

BEGIN;

-- PostgreSQL 的事务性 DDL 保证首次执行要么整体提交、要么整体回滚。这个
-- transaction-local 标志让 ledger 丢失后的第二次执行只重建约束/索引，不会
-- 再把已经按旧 Run 状态迁移过的 input 重新分类。
CREATE TEMP TABLE migration_012_state (
  needs_backfill BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO migration_012_state (needs_backfill)
SELECT NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'platform_run_inputs'
    AND column_name = 'input_sequence'
);

INSERT INTO platform_audit_events (
  audit_event_id,
  actor_user_id,
  workspace_id,
  action,
  object_type,
  object_id,
  outcome,
  metadata_json,
  created_at
)
SELECT
  'migration_012_incompatible_run_' || md5(run_id),
  NULL,
  workspace_id,
  'agent_run.recovery_rejected',
  'run',
  run_id,
  'denied',
  jsonb_build_object(
    'previousSdkStateSchemaVersion', sdk_state_schema_version,
    'targetSdkStateSchemaVersion', 5,
    'reason', 'run_input_checkpoint_cursor_upgrade'
  ),
  NOW()
FROM platform_runs
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 5
  AND status IN (
    'queued', 'running', 'waiting_approval', 'clarification_needed',
    'interrupted', 'requires_action'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '012_run_input_delivery_ack'
  )
ON CONFLICT (audit_event_id) DO NOTHING;

ALTER TABLE platform_run_inputs
  DROP CONSTRAINT IF EXISTS platform_run_inputs_status_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_run_inputs'
      AND column_name = 'consumed_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_run_inputs'
      AND column_name = 'acked_at'
  ) THEN
    ALTER TABLE platform_run_inputs RENAME COLUMN consumed_at TO acked_at;
  END IF;
END
$$;

ALTER TABLE platform_run_inputs
  ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS input_sequence INTEGER,
  ADD COLUMN IF NOT EXISTS lease_id TEXT,
  ADD COLUMN IF NOT EXISTS leased_at TIMESTAMPTZ;

ALTER TABLE platform_runs
  ADD COLUMN IF NOT EXISTS next_input_sequence INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS checkpoint_input_cursor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_input_lease_id TEXT,
  ADD COLUMN IF NOT EXISTS active_input_lease_from INTEGER,
  ADD COLUMN IF NOT EXISTS active_input_lease_to INTEGER;

-- 历史顺序使用已持久化的 conversation entry sequence，不依赖时钟或内存。
WITH sequenced AS (
  SELECT input.input_id,
         ROW_NUMBER() OVER (
           PARTITION BY input.run_id
           ORDER BY entry.sequence, input.input_id
         )::INTEGER AS input_sequence
  FROM platform_run_inputs input
  JOIN platform_conversation_entries entry ON entry.entry_id = input.entry_id
  WHERE (SELECT needs_backfill FROM migration_012_state)
)
UPDATE platform_run_inputs input
SET input_sequence = sequenced.input_sequence
FROM sequenced
WHERE input.input_id = sequenced.input_id;

-- 旧协议的 consumed 发生在模型请求前，不能证明 checkpoint 已包含响应。
-- 必须在把不兼容 v4 Run 标成 failed 之前读取原状态：原可恢复 Run 的全部
-- input 重排 queued/cursor=0；原终态 Run 才能确定性封口为 acked。
UPDATE platform_run_inputs input
SET status = CASE
      WHEN run.status IN ('completed', 'failed', 'cancelled') THEN 'acked'
      ELSE 'queued'
    END,
    lease_id = CASE
      WHEN run.status IN ('completed', 'failed', 'cancelled')
        THEN 'legacy:' || input.input_id
      ELSE NULL
    END,
    leased_at = CASE
      WHEN run.status IN ('completed', 'failed', 'cancelled')
        THEN COALESCE(input.acked_at, input.queued_at)
      ELSE NULL
    END,
    acked_at = CASE
      WHEN run.status IN ('completed', 'failed', 'cancelled')
        THEN COALESCE(input.acked_at, input.queued_at)
      ELSE NULL
    END
FROM platform_runs run
WHERE run.run_id = input.run_id
  AND (SELECT needs_backfill FROM migration_012_state);

WITH input_bounds AS (
  SELECT run_id, COALESCE(MAX(input_sequence), 0)::INTEGER AS max_sequence
  FROM platform_run_inputs
  WHERE (SELECT needs_backfill FROM migration_012_state)
  GROUP BY run_id
)
UPDATE platform_runs run
SET next_input_sequence = input_bounds.max_sequence + 1,
    checkpoint_input_cursor = CASE
      WHEN run.status IN ('completed', 'failed', 'cancelled')
        THEN input_bounds.max_sequence
      ELSE 0
    END,
    active_input_lease_id = NULL,
    active_input_lease_from = NULL,
    active_input_lease_to = NULL
FROM input_bounds
WHERE input_bounds.run_id = run.run_id;

-- v5 不尝试猜测旧 SDK state 是否包含某次输入。先完成 input 原状态迁移，
-- 再显式终止仍可恢复的 v4 Run；queued inputs 因而不会被伪装成 acked。
UPDATE platform_runs
SET status = 'failed',
    state_json = jsonb_set(
      state_json,
      '{errors}',
      COALESCE(state_json->'errors', '[]'::jsonb)
        || jsonb_build_array('Agents SDK 输入确认协议已升级，旧运行不能安全恢复；请重新发起任务。'),
      TRUE
    ),
    pending_tool_call_ids = '[]'::jsonb,
    recovery_status = 'clean',
    updated_at = NOW()
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 5
  AND status IN (
    'queued', 'running', 'waiting_approval', 'clarification_needed',
    'interrupted', 'requires_action'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '012_run_input_delivery_ack'
  );

ALTER TABLE platform_run_inputs
  ALTER COLUMN input_sequence SET NOT NULL;

ALTER TABLE platform_runs
  DROP CONSTRAINT IF EXISTS platform_runs_input_cursor_check;

ALTER TABLE platform_runs
  ADD CONSTRAINT platform_runs_input_cursor_check
    CHECK (
      next_input_sequence > 0
      AND checkpoint_input_cursor >= 0
      AND checkpoint_input_cursor < next_input_sequence
      AND (
        (active_input_lease_id IS NULL AND active_input_lease_from IS NULL AND active_input_lease_to IS NULL)
        OR (
          active_input_lease_id IS NOT NULL
          AND active_input_lease_from = checkpoint_input_cursor + 1
          AND active_input_lease_to >= active_input_lease_from
          AND active_input_lease_to < next_input_sequence
        )
      )
    );

ALTER TABLE platform_run_inputs
  DROP CONSTRAINT IF EXISTS platform_run_inputs_status_check,
  DROP CONSTRAINT IF EXISTS platform_run_inputs_sequence_check,
  DROP CONSTRAINT IF EXISTS platform_run_inputs_delivery_state_check,
  DROP CONSTRAINT IF EXISTS platform_run_inputs_run_sequence_unique;

ALTER TABLE platform_run_inputs
  ADD CONSTRAINT platform_run_inputs_status_check
    CHECK (status IN ('queued', 'leased', 'acked')),
  ADD CONSTRAINT platform_run_inputs_sequence_check
    CHECK (input_sequence > 0),
  ADD CONSTRAINT platform_run_inputs_delivery_state_check
    CHECK (
      (status = 'queued' AND lease_id IS NULL AND leased_at IS NULL AND acked_at IS NULL)
      OR (status = 'leased' AND lease_id IS NOT NULL AND leased_at IS NOT NULL AND acked_at IS NULL)
      OR (status = 'acked' AND lease_id IS NOT NULL AND leased_at IS NOT NULL AND acked_at IS NOT NULL)
    ),
  ADD CONSTRAINT platform_run_inputs_run_sequence_unique
    UNIQUE (run_id, input_sequence);

DROP INDEX IF EXISTS idx_run_inputs_run_status_queued;
CREATE INDEX idx_run_inputs_run_status_queued
  ON platform_run_inputs (run_id, status, input_sequence);

CREATE INDEX IF NOT EXISTS idx_run_inputs_run_lease
  ON platform_run_inputs (run_id, lease_id)
  WHERE lease_id IS NOT NULL;

COMMIT;
