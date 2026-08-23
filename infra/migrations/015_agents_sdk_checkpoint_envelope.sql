-- 地理智能平台 - Agents SDK opaque checkpoint envelope
--
-- v6 将 SDK public serialized state 包裹进平台拥有的严格 envelope，并绑定
-- StepContext/tool-plan/world/input cursor。旧活动 checkpoint 不具备这些事实，
-- 因而只能显式终止，不能 best-effort 恢复或扫描 SDK 内部 JSON。

BEGIN;

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
  'migration_015_incompatible_run_' || md5(run_id),
  NULL,
  workspace_id,
  'agent_run.recovery_rejected',
  'run',
  run_id,
  'denied',
  jsonb_build_object(
    'previousSdkStateSchemaVersion', sdk_state_schema_version,
    'targetSdkStateSchemaVersion', 6,
    'reason', 'opaque_checkpoint_envelope_upgrade'
  ),
  NOW()
FROM platform_runs
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 6
  AND status IN (
    'queued', 'running', 'waiting_approval', 'clarification_needed',
    'interrupted', 'requires_action'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '015_agents_sdk_checkpoint_envelope'
  )
ON CONFLICT (audit_event_id) DO NOTHING;

-- 旧活动 lease 没有 envelope/StepContext 证明，必须恢复为 queued 审计事实；
-- Run 本身随后失败封口，输入不会被伪装为已进入 v6 checkpoint。
UPDATE platform_run_inputs input
SET status = 'queued',
    lease_id = NULL,
    leased_at = NULL,
    acked_at = NULL
FROM platform_runs run
WHERE input.run_id = run.run_id
  AND input.status = 'leased'
  AND run.orchestration_engine = 'openai_agents'
  AND run.sdk_state_schema_version IS DISTINCT FROM 6
  AND run.status IN (
    'queued', 'running', 'waiting_approval', 'clarification_needed',
    'interrupted', 'requires_action'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '015_agents_sdk_checkpoint_envelope'
  );

UPDATE platform_runs
SET status = 'failed',
    state_json = jsonb_set(
      state_json,
      '{errors}',
      COALESCE(state_json->'errors', '[]'::jsonb)
        || jsonb_build_array('Agents SDK checkpoint 已升级为 opaque envelope，旧运行不能安全恢复；请重新发起任务。'),
      TRUE
    ),
    pending_tool_call_ids = '[]'::jsonb,
    recovery_status = 'clean',
    active_input_lease_id = NULL,
    active_input_lease_from = NULL,
    active_input_lease_to = NULL,
    updated_at = NOW()
WHERE orchestration_engine = 'openai_agents'
  AND sdk_state_schema_version IS DISTINCT FROM 6
  AND status IN (
    'queued', 'running', 'waiting_approval', 'clarification_needed',
    'interrupted', 'requires_action'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_schema_migrations
    WHERE migration_id = '015_agents_sdk_checkpoint_envelope'
  );

COMMIT;
