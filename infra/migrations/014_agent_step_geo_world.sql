-- 地理智能平台 - 模型请求级 StepContext 与 GIS 世界状态
--
-- 业务图层、数据集、文件和 Artifact 继续由原表拥有；本迁移只保存每个
-- Run 的不可变事实快照、CAS diff，以及模型请求绑定的 StepContext。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_geo_world_snapshots (
  run_id               TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  workspace_id         TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  state_schema_version INTEGER NOT NULL CHECK (state_schema_version > 0),
  state_digest         TEXT NOT NULL,
  state_json           JSONB NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_geo_world_snapshots_pk PRIMARY KEY (run_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_geo_world_snapshots_workspace_created
  ON platform_geo_world_snapshots (workspace_id, created_at);

-- 014 在开发期曾短暂使用 run_id 单列主键。迁移必须可重入，并把该
-- 草案结构收敛为追加式 (run_id, revision)，不能让已启动过的开发库
-- 继续覆盖历史世界快照。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'platform_geo_world_snapshots'::regclass
      AND conname = 'platform_geo_world_snapshots_pkey'
  ) THEN
    ALTER TABLE platform_geo_world_snapshots
      DROP CONSTRAINT platform_geo_world_snapshots_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'platform_geo_world_snapshots'::regclass
      AND conname = 'platform_geo_world_snapshots_pk'
  ) THEN
    ALTER TABLE platform_geo_world_snapshots
      ADD CONSTRAINT platform_geo_world_snapshots_pk PRIMARY KEY (run_id, revision);
  END IF;
END
$$;

ALTER TABLE platform_geo_world_snapshots
  DROP COLUMN IF EXISTS updated_at;

CREATE TABLE IF NOT EXISTS platform_geo_world_diffs (
  diff_id       TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  from_revision INTEGER NOT NULL CHECK (from_revision > 0),
  to_revision   INTEGER NOT NULL,
  diff_json     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_geo_world_diffs_revision_step_check
    CHECK (to_revision = from_revision + 1),
  CONSTRAINT idx_geo_world_diffs_run_to_revision_unique
    UNIQUE (run_id, to_revision)
);

CREATE TABLE IF NOT EXISTS platform_agent_step_contexts (
  step_id               TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  turn_id               TEXT NOT NULL,
  segment_id            TEXT NOT NULL,
  model_request_index   INTEGER NOT NULL CHECK (model_request_index > 0),
  objective_revision    INTEGER NOT NULL CHECK (objective_revision > 0),
  input_cursor          INTEGER NOT NULL CHECK (input_cursor >= 0),
  world_revision        INTEGER NOT NULL CHECK (world_revision > 0),
  runtime_config_digest TEXT NOT NULL,
  tool_plan_digest      TEXT NOT NULL,
  context_digest        TEXT NOT NULL,
  context_json          JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  CONSTRAINT platform_agent_step_contexts_world_snapshot_fk
    FOREIGN KEY (run_id, world_revision)
    REFERENCES platform_geo_world_snapshots(run_id, revision)
    ON DELETE CASCADE,
  CONSTRAINT idx_agent_step_contexts_run_request_unique
    UNIQUE (run_id, model_request_index)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'platform_agent_step_contexts'::regclass
      AND conname = 'platform_agent_step_contexts_world_snapshot_fk'
  ) THEN
    ALTER TABLE platform_agent_step_contexts
      ADD CONSTRAINT platform_agent_step_contexts_world_snapshot_fk
      FOREIGN KEY (run_id, world_revision)
      REFERENCES platform_geo_world_snapshots(run_id, revision)
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_agent_step_contexts_turn_request
  ON platform_agent_step_contexts (turn_id, model_request_index);

COMMIT;
