-- 地理智能平台 Agents SDK 原生运行时迁移
-- 文件:       004_agents_sdk_native_runtime.sql
-- 日期: 2026年07月23日
-- 作者:       JamesLinYJ
-- 协助:       OpenAI Codex:GPT-5.6 Sol
--
-- 只重置 agent-runtime 配置，并把无法由 schema v3 安全恢复的未完成运行
-- 明确标记为失败。用户、会话、对话、工作流、数据集、图层和 Artifact 不变。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  'migration_004_agent_runtime_reset',
  NULL,
  NULL,
  'agent_runtime_config.reset',
  'runtime_config',
  'agent-runtime',
  'allowed',
  jsonb_build_object(
    'previousDigest', md5(payload_json::text),
    'previousKeys', COALESCE((
      SELECT jsonb_agg(key ORDER BY key)
      FROM jsonb_object_keys(payload_json) AS key
    ), '[]'::jsonb),
    'targetSdkStateSchemaVersion', 3,
    'reason', 'agents_sdk_native_runtime'
  ),
  NOW()
FROM platform_runtime_config
WHERE config_key = 'agent-runtime'
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations WHERE migration_id = '004_agents_sdk_native_runtime'
  )
ON CONFLICT (audit_event_id) DO NOTHING;

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
  'migration_004_incompatible_run_' || md5(run_id),
  NULL,
  workspace_id,
  'agent_run.recovery_rejected',
  'run',
  run_id,
  'denied',
  jsonb_build_object(
    'previousSdkStateSchemaVersion', sdk_state_schema_version,
    'targetSdkStateSchemaVersion', 3,
    'reason', 'incompatible_sdk_checkpoint'
  ),
  NOW()
FROM platform_runs
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 3
  AND status IN ('queued', 'running', 'waiting_approval')
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations WHERE migration_id = '004_agents_sdk_native_runtime'
  )
ON CONFLICT (audit_event_id) DO NOTHING;

UPDATE platform_runs
SET
  status = 'failed',
  state_json = jsonb_set(
    state_json,
    '{errors}',
    COALESCE(state_json->'errors', '[]'::jsonb)
      || jsonb_build_array('Agents SDK 检查点版本已升级，旧运行不能安全恢复；请重新发起任务。'),
    TRUE
  ),
  pending_tool_call_ids = '[]'::jsonb,
  recovery_status = 'clean',
  updated_at = NOW()
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 3
  AND status IN ('queued', 'running', 'waiting_approval')
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations WHERE migration_id = '004_agents_sdk_native_runtime'
  );

DELETE FROM platform_runtime_config
WHERE config_key = 'agent-runtime'
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations WHERE migration_id = '004_agents_sdk_native_runtime'
  );

INSERT INTO platform_schema_migrations (migration_id)
VALUES ('004_agents_sdk_native_runtime')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
