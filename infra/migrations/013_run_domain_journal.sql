-- 地理智能平台 - Run domain journal and shadow reducer snapshots
--
-- 本迁移只建立 Agent control plane 的 append-only 日志与派生 snapshot。
-- platform_runs.state_json 在 WP-02 仍然是生产读取事实源。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_run_domain_events (
  event_id             TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL CHECK (sequence > 0),
  event_type           TEXT NOT NULL,
  schema_version       INTEGER NOT NULL CHECK (schema_version > 0),
  objective_revision   INTEGER NOT NULL CHECK (objective_revision > 0),
  turn_id              TEXT,
  step_id              TEXT,
  causation_id         TEXT,
  correlation_id       TEXT NOT NULL,
  actor_kind           TEXT NOT NULL,
  actor_id             TEXT,
  payload_json         JSONB NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  CONSTRAINT idx_run_domain_events_run_sequence_unique UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_run_domain_events_run_type
  ON platform_run_domain_events (run_id, event_type, sequence);

CREATE TABLE IF NOT EXISTS platform_run_snapshots (
  run_id                  TEXT PRIMARY KEY REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  sequence                INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version > 0),
  state_json              JSONB NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform_run_inputs
    WHERE status NOT IN ('queued', 'leased', 'acked')
  ) THEN
    RAISE EXCEPTION 'migration 013: platform_run_inputs contains an unsupported status';
  END IF;
END $$;

-- 先把每个历史 Run 的创建事实固定为 sequence 1。后续分组事件仅在该
-- Run 实际存在对应输入状态时占用 sequence，顺序由 queued/leased/acked
-- 固定决定，不依赖时间戳或扫描顺序。
INSERT INTO platform_run_domain_events (
  event_id,
  run_id,
  sequence,
  event_type,
  schema_version,
  objective_revision,
  turn_id,
  step_id,
  causation_id,
  correlation_id,
  actor_kind,
  actor_id,
  payload_json,
  occurred_at
)
SELECT
  'domain_migration_013_' || md5(r.run_id || ':created'),
  r.run_id,
  1,
  'run.created',
  1,
  GREATEST(COALESCE((r.state_json ->> 'objectiveRevision')::INTEGER, 1), 1),
  NULL,
  NULL,
  NULL,
  'migration:013:' || r.run_id,
  'user',
  r.created_by_user_id,
  jsonb_build_object('status', r.status, 'state', r.state_json),
  r.created_at
FROM platform_runs r
ON CONFLICT DO NOTHING;

WITH input_flags AS (
  SELECT
    r.run_id,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'queued'
    ) AS has_queued,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'leased'
    ) AS has_leased
  FROM platform_runs r
), grouped AS (
  SELECT
    r.run_id,
    r.state_json,
    r.created_by_user_id,
    f.has_queued,
    f.has_leased,
    i.status,
    CASE i.status
      WHEN 'queued' THEN 2
      WHEN 'leased' THEN 2 + f.has_queued::INTEGER
      ELSE 2 + f.has_queued::INTEGER + f.has_leased::INTEGER
    END AS event_sequence,
    CASE i.status
      WHEN 'queued' THEN 'input.queued'
      WHEN 'leased' THEN 'input.leased'
      ELSE 'input.checkpointed'
    END AS event_type,
    jsonb_agg(
      jsonb_build_object(
        'inputId', i.input_id,
        'inputSequence', i.input_sequence,
        'status', i.status,
        'leaseId', CASE WHEN i.status = 'queued' THEN NULL ELSE i.lease_id END
      )
      ORDER BY i.input_sequence
    ) AS inputs,
    MAX(COALESCE(i.acked_at, i.leased_at, i.queued_at)) AS occurred_at
  FROM platform_runs r
  JOIN input_flags f ON f.run_id = r.run_id
  JOIN platform_run_inputs i ON i.run_id = r.run_id
  GROUP BY r.run_id, r.state_json, r.created_by_user_id, f.has_queued, f.has_leased, i.status
)
INSERT INTO platform_run_domain_events (
  event_id,
  run_id,
  sequence,
  event_type,
  schema_version,
  objective_revision,
  turn_id,
  step_id,
  causation_id,
  correlation_id,
  actor_kind,
  actor_id,
  payload_json,
  occurred_at
)
SELECT
  'domain_migration_013_' || md5(g.run_id || ':' || g.event_type),
  g.run_id,
  g.event_sequence,
  g.event_type,
  1,
  GREATEST(COALESCE((g.state_json ->> 'objectiveRevision')::INTEGER, 1), 1),
  NULL,
  NULL,
  NULL,
  'migration:013:' || g.run_id,
  CASE WHEN g.status = 'queued' THEN 'user' ELSE 'system' END,
  CASE WHEN g.status = 'queued' THEN g.created_by_user_id ELSE NULL END,
  jsonb_build_object('inputs', g.inputs),
  g.occurred_at
FROM grouped g
ON CONFLICT DO NOTHING;

WITH flags AS (
  SELECT
    r.run_id,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'queued'
    ) AS has_queued,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'leased'
    ) AS has_leased,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'acked'
    ) AS has_acked
  FROM platform_runs r
)
INSERT INTO platform_run_domain_events (
  event_id,
  run_id,
  sequence,
  event_type,
  schema_version,
  objective_revision,
  turn_id,
  step_id,
  causation_id,
  correlation_id,
  actor_kind,
  actor_id,
  payload_json,
  occurred_at
)
SELECT
  'domain_migration_013_' || md5(r.run_id || ':checkpoint'),
  r.run_id,
  2 + f.has_queued::INTEGER + f.has_leased::INTEGER + f.has_acked::INTEGER,
  'run.checkpoint_changed',
  1,
  GREATEST(COALESCE((r.state_json ->> 'objectiveRevision')::INTEGER, 1), 1),
  NULL,
  NULL,
  NULL,
  'migration:013:' || r.run_id,
  'system',
  NULL,
  jsonb_build_object('checkpoint', jsonb_build_object(
    'activeEntryId', r.active_entry_id,
    'pendingToolCallIds', r.pending_tool_call_ids,
    'recoveryStatus', r.recovery_status,
    'orchestrationEngine', r.orchestration_engine,
    'sdkStateContentHash', r.sdk_state_content_hash,
    'agentsSdkVersion', r.sdk_version,
    'runtimeConfigDigest', r.runtime_config_digest,
    'sdkStateSchemaVersion', r.sdk_state_schema_version,
    'nextInputSequence', r.next_input_sequence,
    'checkpointInputCursor', r.checkpoint_input_cursor,
    'activeInputLeaseId', r.active_input_lease_id
  )),
  r.updated_at
FROM platform_runs r
JOIN flags f ON f.run_id = r.run_id
ON CONFLICT DO NOTHING;

-- Snapshot 是上述事件的 reducer cache。它只从同一批确定性事实构造，
-- 不引入独立默认值；任意历史 Run 都可删除 snapshot 后从事件重建。
WITH flags AS (
  SELECT
    r.run_id,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'queued'
    ) AS has_queued,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'leased'
    ) AS has_leased,
    EXISTS (
      SELECT 1 FROM platform_run_inputs i
      WHERE i.run_id = r.run_id AND i.status = 'acked'
    ) AS has_acked
  FROM platform_runs r
), deliveries AS (
  SELECT
    i.run_id,
    jsonb_object_agg(
      i.input_id,
      jsonb_build_object(
        'inputId', i.input_id,
        'inputSequence', i.input_sequence,
        'status', i.status,
        'leaseId', CASE WHEN i.status = 'queued' THEN NULL ELSE i.lease_id END
      )
    ) AS value
  FROM platform_run_inputs i
  GROUP BY i.run_id
)
INSERT INTO platform_run_snapshots (
  run_id,
  sequence,
  snapshot_schema_version,
  state_json,
  updated_at
)
SELECT
  r.run_id,
  2 + f.has_queued::INTEGER + f.has_leased::INTEGER + f.has_acked::INTEGER,
  1,
  jsonb_build_object(
    'schemaVersion', 1,
    'runId', r.run_id,
    'sequence', 2 + f.has_queued::INTEGER + f.has_leased::INTEGER + f.has_acked::INTEGER,
    'status', r.status,
    'state', r.state_json,
    'inputDeliveries', COALESCE(d.value, '{}'::JSONB),
    'checkpoint', jsonb_build_object(
      'activeEntryId', r.active_entry_id,
      'pendingToolCallIds', r.pending_tool_call_ids,
      'recoveryStatus', r.recovery_status,
      'orchestrationEngine', r.orchestration_engine,
      'sdkStateContentHash', r.sdk_state_content_hash,
      'agentsSdkVersion', r.sdk_version,
      'runtimeConfigDigest', r.runtime_config_digest,
      'sdkStateSchemaVersion', r.sdk_state_schema_version,
      'nextInputSequence', r.next_input_sequence,
      'checkpointInputCursor', r.checkpoint_input_cursor,
      'activeInputLeaseId', r.active_input_lease_id
    ),
    'updatedAt', to_char(
      r.updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  ),
  r.updated_at
FROM platform_runs r
JOIN flags f ON f.run_id = r.run_id
LEFT JOIN deliveries d ON d.run_id = r.run_id
ON CONFLICT DO NOTHING;

COMMIT;
