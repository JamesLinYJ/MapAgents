-- +-------------------------------------------------------------------------
--
--   地理智能平台 - Automation 可靠性约束升级
--
--   文件:       002_automation_reliability_constraints.sql
--
--   日期:       2026年07月18日
--   作者:       OpenAI Codex
-- --------------------------------------------------------------------------

BEGIN;

DO $migration$
BEGIN
  IF to_regclass('public.platform_automation_definitions') IS NULL
    OR to_regclass('public.platform_automation_versions') IS NULL
    OR to_regclass('public.platform_scheduled_tasks') IS NULL
    OR to_regclass('public.platform_automation_runs') IS NULL THEN
    RAISE EXCEPTION 'Automation 基础表缺失，必须先应用 001_init_postgis.sql';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_definitions'::regclass
      AND conname = 'platform_automation_definitions_source_check'
  ) THEN
    ALTER TABLE platform_automation_definitions
      ADD CONSTRAINT platform_automation_definitions_source_check
      CHECK (source IN ('builtin', 'workspace')) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_definitions
    VALIDATE CONSTRAINT platform_automation_definitions_source_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_definitions'::regclass
      AND conname = 'platform_automation_definitions_lifecycle_check'
  ) THEN
    ALTER TABLE platform_automation_definitions
      ADD CONSTRAINT platform_automation_definitions_lifecycle_check
      CHECK (lifecycle IN ('draft', 'published', 'disabled')) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_definitions
    VALIDATE CONSTRAINT platform_automation_definitions_lifecycle_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_definitions'::regclass
      AND conname = 'platform_automation_definitions_revision_check'
  ) THEN
    ALTER TABLE platform_automation_definitions
      ADD CONSTRAINT platform_automation_definitions_revision_check
      CHECK (revision > 0) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_definitions
    VALIDATE CONSTRAINT platform_automation_definitions_revision_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_definitions'::regclass
      AND conname = 'platform_automation_definitions_timeout_check'
  ) THEN
    ALTER TABLE platform_automation_definitions
      ADD CONSTRAINT platform_automation_definitions_timeout_check
      CHECK (timeout_seconds > 0) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_definitions
    VALIDATE CONSTRAINT platform_automation_definitions_timeout_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_definitions'::regclass
      AND conname = 'platform_automation_definitions_ownership_check'
  ) THEN
    ALTER TABLE platform_automation_definitions
      ADD CONSTRAINT platform_automation_definitions_ownership_check
      CHECK (
        (source = 'builtin' AND workspace_id IS NULL)
        OR (source = 'workspace' AND workspace_id IS NOT NULL)
      ) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_definitions
    VALIDATE CONSTRAINT platform_automation_definitions_ownership_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_versions'::regclass
      AND conname = 'platform_automation_versions_lifecycle_check'
  ) THEN
    ALTER TABLE platform_automation_versions
      ADD CONSTRAINT platform_automation_versions_lifecycle_check
      CHECK (lifecycle IN ('draft', 'published', 'archived')) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_versions
    VALIDATE CONSTRAINT platform_automation_versions_lifecycle_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_versions'::regclass
      AND conname = 'platform_automation_versions_revision_check'
  ) THEN
    ALTER TABLE platform_automation_versions
      ADD CONSTRAINT platform_automation_versions_revision_check
      CHECK (revision > 0) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_versions
    VALIDATE CONSTRAINT platform_automation_versions_revision_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_scheduled_tasks'::regclass
      AND conname = 'platform_scheduled_tasks_target_id_fkey'
  ) THEN
    ALTER TABLE platform_scheduled_tasks
      ADD CONSTRAINT platform_scheduled_tasks_target_id_fkey
      FOREIGN KEY (target_id)
      REFERENCES platform_automation_definitions(automation_id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  ALTER TABLE platform_scheduled_tasks
    VALIDATE CONSTRAINT platform_scheduled_tasks_target_id_fkey;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_scheduled_tasks'::regclass
      AND conname = 'platform_scheduled_tasks_target_kind_check'
  ) THEN
    ALTER TABLE platform_scheduled_tasks
      ADD CONSTRAINT platform_scheduled_tasks_target_kind_check
      CHECK (target_kind = 'automation') NOT VALID;
  END IF;
  ALTER TABLE platform_scheduled_tasks
    VALIDATE CONSTRAINT platform_scheduled_tasks_target_kind_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_scheduled_tasks'::regclass
      AND conname = 'platform_scheduled_tasks_status_check'
  ) THEN
    ALTER TABLE platform_scheduled_tasks
      ADD CONSTRAINT platform_scheduled_tasks_status_check
      CHECK (status IN ('active', 'paused', 'missed', 'failed', 'deleted')) NOT VALID;
  END IF;
  ALTER TABLE platform_scheduled_tasks
    VALIDATE CONSTRAINT platform_scheduled_tasks_status_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_scheduled_tasks'::regclass
      AND conname = 'platform_scheduled_tasks_failure_count_check'
  ) THEN
    ALTER TABLE platform_scheduled_tasks
      ADD CONSTRAINT platform_scheduled_tasks_failure_count_check
      CHECK (failure_count >= 0) NOT VALID;
  END IF;
  ALTER TABLE platform_scheduled_tasks
    VALIDATE CONSTRAINT platform_scheduled_tasks_failure_count_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_runs'::regclass
      AND conname = 'platform_automation_runs_definition_revision_fk'
  ) THEN
    ALTER TABLE platform_automation_runs
      ADD CONSTRAINT platform_automation_runs_definition_revision_fk
      FOREIGN KEY (automation_id, automation_revision)
      REFERENCES platform_automation_versions(automation_id, revision)
      ON DELETE RESTRICT NOT VALID;
  END IF;
  ALTER TABLE platform_automation_runs
    VALIDATE CONSTRAINT platform_automation_runs_definition_revision_fk;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_runs'::regclass
      AND conname = 'platform_automation_runs_status_check'
  ) THEN
    ALTER TABLE platform_automation_runs
      ADD CONSTRAINT platform_automation_runs_status_check
      CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_runs
    VALIDATE CONSTRAINT platform_automation_runs_status_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'platform_automation_runs'::regclass
      AND conname = 'platform_automation_runs_trigger_kind_check'
  ) THEN
    ALTER TABLE platform_automation_runs
      ADD CONSTRAINT platform_automation_runs_trigger_kind_check
      CHECK (trigger_kind IN ('manual', 'schedule', 'agent')) NOT VALID;
  END IF;
  ALTER TABLE platform_automation_runs
    VALIDATE CONSTRAINT platform_automation_runs_trigger_kind_check;

  -- 旧基线只约束 automation_id；复合外键验证通过后移除冗余旧约束。
  ALTER TABLE platform_automation_runs
    DROP CONSTRAINT IF EXISTS platform_automation_runs_automation_id_fkey;
END
$migration$;

COMMIT;
