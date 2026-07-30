-- GeoForge 原生运行时配置迁移
-- 文件:       006_native_agent_runtime.sql
-- 日期: 2026年07月29日
-- 作者:       JamesLinYJ
-- 协助:       OpenAI Codex:GPT-5.6 Sol
--
-- 只重置包含旧沙箱后端的 agent-runtime 配置，并把 schema v4 之前
-- 无法安全恢复的未完成 SDK 运行标记为失败。业务数据与历史对话保持不变。

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
  'migration_006_native_runtime_config_reset',
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
    'targetSdkStateSchemaVersion', 4,
    'reason', 'native_agent_runtime_upgrade'
  ),
  NOW()
FROM platform_runtime_config
WHERE config_key = 'agent-runtime'
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '006_native_agent_runtime'
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
  'migration_006_incompatible_run_' || md5(run_id),
  NULL,
  workspace_id,
  'agent_run.recovery_rejected',
  'run',
  run_id,
  'denied',
  jsonb_build_object(
    'previousSdkStateSchemaVersion', sdk_state_schema_version,
    'targetSdkStateSchemaVersion', 4,
    'reason', 'incompatible_native_runtime_checkpoint'
  ),
  NOW()
FROM platform_runs
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 4
  AND status IN ('queued', 'running', 'waiting_approval')
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '006_native_agent_runtime'
  )
ON CONFLICT (audit_event_id) DO NOTHING;

UPDATE platform_runs
SET
  status = 'failed',
  state_json = jsonb_set(
    state_json,
    '{errors}',
    COALESCE(state_json->'errors', '[]'::jsonb)
      || jsonb_build_array('Agents SDK 原生运行时版本已升级，旧运行不能安全恢复；请重新发起任务。'),
    TRUE
  ),
  pending_tool_call_ids = '[]'::jsonb,
  recovery_status = 'clean',
  updated_at = NOW()
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 4
  AND status IN ('queued', 'running', 'waiting_approval')
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '006_native_agent_runtime'
  );

DELETE FROM platform_runtime_config
WHERE config_key = 'agent-runtime'
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '006_native_agent_runtime'
  );

INSERT INTO platform_schema_migrations (migration_id)
VALUES ('006_native_agent_runtime')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
