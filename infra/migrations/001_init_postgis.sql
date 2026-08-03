-- +-------------------------------------------------------------------------
--
--   地理智能平台 Baseline Schema — 全新 PostGIS 数据库初始化
--
--   文件:       001_init_postgis.sql
--
--   日期:       2026年06月22日
--   作者:       JamesLinYJ
--   协助:       OpenAI Codex:GPT-5.5
--
--   用途:       创建全部核心表、索引、约束。
--               不包含旧登录/session 兼容代码。
--               应在首次部署或 reset 后作为第一步执行。
--
--   维护记录 (2026-07-31):
--     作者: JamesLinYJ
--     协助: OpenAI Codex:GPT-5.6 Sol
--     说明: 将历史增量 SQL 合并为单一事务化基线；旧数据库必须显式重建，
--           不再通过兼容补丁逐级升级。
-- --------------------------------------------------------------------------

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $baseline$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform_schema_migrations
    WHERE migration_id <> '001_init_postgis'
  ) AND NOT EXISTS (
    SELECT 1
    FROM platform_schema_migrations
    WHERE migration_id = '001_init_postgis'
  ) THEN
    RAISE EXCEPTION
      '检测到旧数据库迁移链；当前基线只支持全新数据库，请先执行开发数据库重建。';
  END IF;
END
$baseline$;

-- ==========================================================================
-- Better Auth 认证表（auth_user / auth_session / auth_account / auth_verification）
-- ==========================================================================

CREATE TABLE IF NOT EXISTS auth_user (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  image           TEXT,
  role            TEXT NOT NULL DEFAULT 'user',
  banned          BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason      TEXT,
  ban_expires     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_email_unique ON auth_user (email);

CREATE TABLE IF NOT EXISTS auth_session (
  id           TEXT PRIMARY KEY,
  expires_at   TIMESTAMPTZ NOT NULL,
  token        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   TEXT,
  user_agent   TEXT,
  impersonated_by TEXT,
  user_id      TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_session_token_unique ON auth_session (token);
CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session (user_id);

CREATE TABLE IF NOT EXISTS auth_account (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL,
  provider_id               TEXT NOT NULL,
  user_id                   TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  access_token              TEXT,
  refresh_token             TEXT,
  id_token                  TEXT,
  access_token_expires_at   TIMESTAMPTZ,
  refresh_token_expires_at  TIMESTAMPTZ,
  scope                     TEXT,
  password                  TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_account_user_id ON auth_account (user_id);

CREATE TABLE IF NOT EXISTS auth_verification (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  value        TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON auth_verification (identifier);

-- ==========================================================================
-- 平台用户 / 工作区 / 成员 / RBAC / 审计
-- ==========================================================================

CREATE TABLE IF NOT EXISTS platform_users (
  user_id        TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  email          TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_subject_unique ON platform_users (subject);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_email_unique ON platform_users (email);

CREATE TABLE IF NOT EXISTS platform_workspaces (
  workspace_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active',
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_memberships (
  membership_id TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_memberships_member_role_unique
  ON platform_memberships (workspace_id, user_id, role);
CREATE INDEX IF NOT EXISTS idx_platform_memberships_workspace ON platform_memberships (workspace_id);
CREATE INDEX IF NOT EXISTS idx_platform_memberships_user ON platform_memberships (user_id);

-- ==========================================================================
-- 会话事实源 / 运行记录 / 事务 outbox
-- ==========================================================================

CREATE TABLE IF NOT EXISTS platform_sessions (
  session_id                     TEXT PRIMARY KEY,
  workspace_id                   TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id             TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility                     TEXT NOT NULL DEFAULT 'workspace',
  status                         TEXT NOT NULL DEFAULT 'active',
  latest_thread_id               TEXT,
  latest_run_id                  TEXT,
  latest_uploaded_layer_key      TEXT,
  latest_meteorological_dataset_id TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_workspace_updated
  ON platform_sessions (workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_owner_updated
  ON platform_sessions (created_by_user_id, updated_at);

CREATE TABLE IF NOT EXISTS platform_threads (
  thread_id                TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  workspace_id             TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id       TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility               TEXT NOT NULL DEFAULT 'workspace',
  title                    TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active',
  latest_run_id            TEXT,
  latest_user_query        TEXT,
  latest_assistant_summary TEXT,
  latest_run_status        TEXT,
  latest_artifact_id       TEXT,
  latest_artifact_name     TEXT,
  history_preview          TEXT,
  run_count                INTEGER NOT NULL DEFAULT 0,
  next_entry_sequence      INTEGER NOT NULL DEFAULT 1 CHECK (next_entry_sequence > 0),
  active_leaf_entry_id     TEXT,
  transcript_entry_count   INTEGER NOT NULL DEFAULT 0,
  estimated_context_tokens INTEGER NOT NULL DEFAULT 0,
  latest_compaction_id     TEXT,
  memory_version           INTEGER NOT NULL DEFAULT 0,
  memory_based_on_tokens   INTEGER NOT NULL DEFAULT 0,
  forked_from_thread_id    TEXT,
  forked_from_entry_id     TEXT,
  quarantined              BOOLEAN NOT NULL DEFAULT FALSE,
  quarantine_reason        TEXT,
  deleted_at               TIMESTAMPTZ,
  purge_after              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_threads_session_updated
  ON platform_threads (session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_threads_workspace_updated
  ON platform_threads (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS platform_runs (
  run_id                  TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  thread_id               TEXT REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  workspace_id            TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id      TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility              TEXT NOT NULL DEFAULT 'workspace',
  user_query              TEXT NOT NULL,
  model_provider          TEXT,
  model_name              TEXT,
  status                  TEXT NOT NULL DEFAULT 'queued',
  state_json              JSONB NOT NULL,
  runtime_config_json     JSONB,
  active_entry_id         TEXT,
  pending_tool_call_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  recovery_status         TEXT NOT NULL DEFAULT 'clean',
  orchestration_engine    TEXT,
  sdk_state_content_hash  TEXT,
  sdk_version             TEXT,
  runtime_config_digest   TEXT,
  sdk_state_schema_version INTEGER,
  sdk_state_updated_at    TIMESTAMPTZ,
  next_record_sequence    INTEGER NOT NULL DEFAULT 1 CHECK (next_record_sequence > 0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_runs_thread_updated
  ON platform_runs (thread_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_runs_session_updated
  ON platform_runs (session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_runs_workspace_updated
  ON platform_runs (workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_runs_status_updated
  ON platform_runs (status, updated_at);

CREATE TABLE IF NOT EXISTS platform_conversation_entries (
  entry_id               TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  thread_id              TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  run_id                 TEXT REFERENCES platform_runs(run_id) ON DELETE SET NULL,
  turn_id                TEXT,
  sequence               INTEGER NOT NULL CHECK (sequence > 0),
  parent_entry_id        TEXT REFERENCES platform_conversation_entries(entry_id) ON DELETE SET NULL,
  logical_parent_entry_id TEXT REFERENCES platform_conversation_entries(entry_id) ON DELETE SET NULL,
  kind                   TEXT NOT NULL,
  payload_json           JSONB NOT NULL,
  trace_id               TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_entries_thread_sequence_unique
  ON platform_conversation_entries (thread_id, sequence);
CREATE INDEX IF NOT EXISTS idx_conversation_entries_run_created
  ON platform_conversation_entries (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_entries_parent
  ON platform_conversation_entries (parent_entry_id);

CREATE TABLE IF NOT EXISTS platform_thread_memory_versions (
  thread_id         TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  version           INTEGER NOT NULL CHECK (version > 0),
  content_hash      TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source            TEXT NOT NULL,
  based_on_entry_id TEXT REFERENCES platform_conversation_entries(entry_id) ON DELETE SET NULL,
  estimated_tokens  INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, version)
);
CREATE INDEX IF NOT EXISTS idx_thread_memory_versions_thread_created
  ON platform_thread_memory_versions (thread_id, created_at);

CREATE TABLE IF NOT EXISTS platform_thread_compactions (
  compaction_id           TEXT PRIMARY KEY,
  thread_id               TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  boundary_entry_id       TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE,
  summary_entry_id        TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE,
  first_compacted_entry_id TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE,
  last_compacted_entry_id TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE,
  preserved_from_entry_id TEXT REFERENCES platform_conversation_entries(entry_id) ON DELETE SET NULL,
  summary                 TEXT NOT NULL,
  strategy                TEXT NOT NULL,
  pre_tokens              INTEGER NOT NULL CHECK (pre_tokens >= 0),
  post_tokens             INTEGER NOT NULL CHECK (post_tokens >= 0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_thread_compactions_thread_created
  ON platform_thread_compactions (thread_id, created_at);

CREATE TABLE IF NOT EXISTS platform_run_records (
  record_id    TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  thread_id    TEXT REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL CHECK (sequence > 0),
  record_type  TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  trace_id     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_run_records_run_type_created
  ON platform_run_records (run_id, record_type, created_at);
CREATE INDEX IF NOT EXISTS idx_run_records_trace
  ON platform_run_records (trace_id);

CREATE TABLE IF NOT EXISTS platform_run_inputs (
  input_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'steering',
  content      TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'consumed', 'rejected')),
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at  TIMESTAMPTZ,
  UNIQUE (entry_id)
);
CREATE INDEX IF NOT EXISTS idx_run_inputs_run_status_queued
  ON platform_run_inputs (run_id, status, queued_at);

CREATE TABLE IF NOT EXISTS platform_event_outbox (
  outbox_id       TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload_json    JSONB NOT NULL,
  trace_id        TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_event_outbox_unpublished
  ON platform_event_outbox (published_at, created_at);
CREATE INDEX IF NOT EXISTS idx_event_outbox_aggregate
  ON platform_event_outbox (aggregate_type, aggregate_id, created_at);

CREATE TABLE IF NOT EXISTS platform_rbac_policies (
  policy_id TEXT PRIMARY KEY,
  ptype     TEXT NOT NULL,
  v0        TEXT NOT NULL DEFAULT '',
  v1        TEXT NOT NULL DEFAULT '',
  v2        TEXT NOT NULL DEFAULT '',
  v3        TEXT NOT NULL DEFAULT '',
  v4        TEXT NOT NULL DEFAULT '',
  v5        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_rbac_policy_unique
  ON platform_rbac_policies (ptype, v0, v1, v2, v3, v4, v5);

CREATE TABLE IF NOT EXISTS platform_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  actor_user_id  TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  workspace_id   TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  object_type    TEXT NOT NULL,
  object_id      TEXT,
  outcome        TEXT NOT NULL DEFAULT 'allowed',
  metadata_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_workspace_created ON platform_audit_events (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_audit_actor_created ON platform_audit_events (actor_user_id, created_at);

-- ==========================================================================
-- 产物 / 图层 / Runtime 配置 / Tool Catalog
-- ==========================================================================

CREATE TABLE IF NOT EXISTS platform_artifacts (
  artifact_id           TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  workspace_id          TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id    TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility            TEXT NOT NULL DEFAULT 'workspace',
  artifact_type         TEXT NOT NULL,
  name                  TEXT NOT NULL,
  uri                   TEXT NOT NULL,
  display_json          JSONB NOT NULL,
  metadata_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_relative_path TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_run_id ON platform_artifacts (run_id);

CREATE TABLE IF NOT EXISTS platform_map_layers (
  map_layer_id       TEXT PRIMARY KEY,
  ownership_scope    TEXT NOT NULL CHECK (ownership_scope IN ('system', 'workspace', 'thread')),
  workspace_id       TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  thread_id          TEXT REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  artifact_id        TEXT REFERENCES platform_artifacts(artifact_id) ON DELETE CASCADE,
  managed_layer_key  TEXT,
  title              TEXT NOT NULL,
  replacement_group  TEXT,
  source_type        TEXT NOT NULL DEFAULT 'artifact',
  geometry_type      TEXT NOT NULL DEFAULT 'unknown',
  srid                INTEGER NOT NULL DEFAULT 4326,
  description         TEXT NOT NULL DEFAULT '',
  feature_count       INTEGER CHECK (feature_count IS NULL OR feature_count >= 0),
  property_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  category            TEXT NOT NULL DEFAULT 'general',
  tags_json           JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis_capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_config_summary TEXT,
  session_id          TEXT REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  created_by_user_id  TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility          TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('private', 'workspace', 'public')),
  readonly            BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed', 'disabled')),
  error_message      TEXT,
  bounds_json        JSONB NOT NULL,
  crs                TEXT NOT NULL,
  min_zoom           INTEGER NOT NULL DEFAULT 0 CHECK (min_zoom BETWEEN 0 AND 24),
  max_zoom           INTEGER NOT NULL DEFAULT 22 CHECK (max_zoom BETWEEN 0 AND 24 AND max_zoom >= min_zoom),
  source_json        JSONB NOT NULL,
  style_json         JSONB NOT NULL,
  legend_json        JSONB,
  temporal_json      JSONB,
  capabilities_json  JSONB NOT NULL,
  data_version       INTEGER NOT NULL DEFAULT 1 CHECK (data_version > 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_platform_map_layers_owner CHECK ((artifact_id IS NULL) <> (managed_layer_key IS NULL)),
  CONSTRAINT chk_platform_map_layers_scope CHECK (
    (ownership_scope = 'system' AND workspace_id IS NULL AND thread_id IS NULL)
    OR (ownership_scope = 'workspace' AND workspace_id IS NOT NULL AND thread_id IS NULL)
    OR (ownership_scope = 'thread' AND workspace_id IS NOT NULL AND thread_id IS NOT NULL)
  ),
  CONSTRAINT chk_platform_map_layers_failure CHECK (status <> 'failed' OR error_message IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_map_layers_artifact_unique
  ON platform_map_layers (artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_map_layers_managed_unique
  ON platform_map_layers (managed_layer_key);
CREATE INDEX IF NOT EXISTS idx_platform_map_layers_thread_updated
  ON platform_map_layers (thread_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_map_layers_thread_replacement
  ON platform_map_layers (thread_id, replacement_group, updated_at);
CREATE INDEX IF NOT EXISTS idx_platform_map_layers_workspace_updated
  ON platform_map_layers (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS platform_map_scenes (
  scene_id      TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL REFERENCES platform_threads(thread_id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  default_layers_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (thread_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_map_scenes_workspace_updated
  ON platform_map_scenes (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS platform_map_scene_layers (
  scene_id             TEXT NOT NULL REFERENCES platform_map_scenes(scene_id) ON DELETE CASCADE,
  map_layer_id         TEXT NOT NULL REFERENCES platform_map_layers(map_layer_id) ON DELETE CASCADE,
  layer_order          INTEGER NOT NULL CHECK (layer_order >= 0),
  visible              BOOLEAN NOT NULL DEFAULT TRUE,
  opacity_percent      INTEGER NOT NULL DEFAULT 100 CHECK (opacity_percent BETWEEN 0 AND 100),
  style_override_json  JSONB,
  label_json           JSONB,
  current_frame_id     TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scene_id, map_layer_id),
  UNIQUE (scene_id, layer_order)
);

CREATE TABLE IF NOT EXISTS platform_layer_features (
  map_layer_id    TEXT NOT NULL REFERENCES platform_map_layers(map_layer_id) ON DELETE CASCADE,
  feature_id      TEXT NOT NULL,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  geometry        geometry(Geometry, 4326) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (map_layer_id, feature_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_layer_features_layer
  ON platform_layer_features (map_layer_id);
CREATE INDEX IF NOT EXISTS idx_platform_layer_features_geometry
  ON platform_layer_features USING GIST (geometry);

-- Node 地图网关只调用这个经过审计的固定函数。query 中仅接收已授权的
-- mapLayerId；数据库表名、SQL 和任意筛选条件都不会跨越 HTTP 边界。
CREATE OR REPLACE FUNCTION geo_agent_platform_layer_tiles(z integer, x integer, y integer, query json)
RETURNS bytea
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH tile_bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS geometry
  ), query_bounds AS (
    SELECT ST_Transform(
      ST_TileEnvelope(z, x, y, margin => (64.0 / 4096)),
      4326
    ) AS geometry
  ), tile_features AS (
    SELECT
      feature.feature_id,
      feature.properties_json,
      ST_AsMVTGeom(
        ST_Transform(feature.geometry, 3857),
        tile_bounds.geometry,
        4096,
        64,
        true
      ) AS geometry
    FROM platform_layer_features AS feature
    CROSS JOIN tile_bounds
    CROSS JOIN query_bounds
    WHERE feature.map_layer_id = query->>'mapLayerId'
      AND feature.geometry && query_bounds.geometry
  )
  -- ST_AsMVT 的第五个参数只接受整数列作为 MVT feature id。地理智能平台 的
  -- feature_id 是跨导入稳定的文本标识，因此保留为普通 MVT 属性；MapLibre
  -- 查询结果仍可读取它，同时不会让 PostGIS 因错误的整数主键契约而拒绝出瓦片。
  SELECT ST_AsMVT(tile_features, 'features', 4096, 'geometry')
  FROM tile_features;
$$;

CREATE TABLE IF NOT EXISTS platform_runtime_config (
  config_key   TEXT PRIMARY KEY,
  updated_at   TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_catalog_entries (
  tool_name  TEXT NOT NULL,
  tool_kind  TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_name, tool_kind)
);

-- ==========================================================================
-- 气象数据集 / 处理任务
-- ==========================================================================

CREATE TABLE IF NOT EXISTS platform_meteorological_datasets (
  dataset_id          TEXT PRIMARY KEY,
  workspace_id        TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id  TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  visibility          TEXT NOT NULL DEFAULT 'workspace',
  session_id          TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  thread_id           TEXT REFERENCES platform_threads(thread_id) ON DELETE SET NULL,
  filename            TEXT NOT NULL,
  original_filename   TEXT NOT NULL,
  file_id             TEXT,
  file_relative_path  TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  content_hash        TEXT,
  media_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
  status              TEXT NOT NULL DEFAULT 'ready',
  metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meteorological_datasets_session_updated
  ON platform_meteorological_datasets (session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_meteorological_datasets_thread_updated
  ON platform_meteorological_datasets (thread_id, updated_at);

CREATE TABLE IF NOT EXISTS platform_meteorological_jobs (
  job_id             TEXT PRIMARY KEY,
  dataset_id         TEXT NOT NULL REFERENCES platform_meteorological_datasets(dataset_id) ON DELETE CASCADE,
  workspace_id       TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  session_id         TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  thread_id          TEXT REFERENCES platform_threads(thread_id) ON DELETE SET NULL,
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  message            TEXT,
  payload_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_meteorological_jobs_dataset_updated
  ON platform_meteorological_jobs (dataset_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_meteorological_jobs_session_updated
  ON platform_meteorological_jobs (session_id, updated_at);

-- ==========================================================================
-- Automation / 定时任务 / 后台运行索引
-- ==========================================================================

CREATE TABLE IF NOT EXISTS platform_automation_definitions (
  automation_id             TEXT PRIMARY KEY,
  workspace_id            TEXT REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id      TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  version                 TEXT NOT NULL,
  revision                INTEGER NOT NULL DEFAULT 1,
  published_revision      INTEGER,
  source                  TEXT NOT NULL DEFAULT 'builtin',
  lifecycle               TEXT NOT NULL DEFAULT 'published',
  enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  parameters_schema_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_tools_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  requires_approval       BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_seconds         INTEGER NOT NULL DEFAULT 900,
  output_type             TEXT NOT NULL DEFAULT 'conversation',
  definition_json         JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_automation_definitions_source_check CHECK (source IN ('builtin', 'workspace')),
  CONSTRAINT platform_automation_definitions_lifecycle_check CHECK (lifecycle IN ('draft', 'published', 'disabled')),
  CONSTRAINT platform_automation_definitions_revision_check CHECK (revision > 0),
  CONSTRAINT platform_automation_definitions_timeout_check CHECK (timeout_seconds > 0),
  CONSTRAINT platform_automation_definitions_ownership_check CHECK (
    (source = 'builtin' AND workspace_id IS NULL)
    OR (source = 'workspace' AND workspace_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_workspace_updated
  ON platform_automation_definitions (workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_source_lifecycle
  ON platform_automation_definitions (source, lifecycle);

CREATE TABLE IF NOT EXISTS platform_automation_versions (
  automation_id        TEXT NOT NULL REFERENCES platform_automation_definitions(automation_id) ON DELETE CASCADE,
  revision           INTEGER NOT NULL,
  lifecycle          TEXT NOT NULL,
  definition_json    JSONB NOT NULL,
  created_by_user_id TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at       TIMESTAMPTZ,
  PRIMARY KEY (automation_id, revision),
  CONSTRAINT platform_automation_versions_lifecycle_check CHECK (lifecycle IN ('draft', 'published', 'archived')),
  CONSTRAINT platform_automation_versions_revision_check CHECK (revision > 0)
);
CREATE INDEX IF NOT EXISTS idx_automation_versions_lifecycle
  ON platform_automation_versions (automation_id, lifecycle);

CREATE TABLE IF NOT EXISTS platform_scheduled_tasks (
  task_id            TEXT PRIMARY KEY,
  target_kind        TEXT NOT NULL,
  target_id          TEXT NOT NULL REFERENCES platform_automation_definitions(automation_id) ON DELETE RESTRICT,
  workspace_id       TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
  title              TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  parameters_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  cron               TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  recurring          BOOLEAN NOT NULL DEFAULT TRUE,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  status             TEXT NOT NULL DEFAULT 'active',
  last_fired_at      TIMESTAMPTZ,
  next_fire_at       TIMESTAMPTZ,
  last_run_id        TEXT REFERENCES platform_runs(run_id) ON DELETE SET NULL,
  queue_job_id       TEXT,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_error_message TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_scheduled_tasks_target_kind_check CHECK (target_kind = 'automation'),
  CONSTRAINT platform_scheduled_tasks_status_check CHECK (status IN ('active', 'paused', 'missed', 'failed', 'deleted')),
  CONSTRAINT platform_scheduled_tasks_failure_count_check CHECK (failure_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_workspace_next
  ON platform_scheduled_tasks (workspace_id, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_target
  ON platform_scheduled_tasks (target_kind, target_id);

CREATE TABLE IF NOT EXISTS platform_automation_runs (
  automation_run_id    TEXT PRIMARY KEY,
  automation_id        TEXT NOT NULL,
  automation_revision  INTEGER NOT NULL,
  scheduled_task_id  TEXT REFERENCES platform_scheduled_tasks(task_id) ON DELETE SET NULL,
  workspace_id       TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
  run_id             TEXT REFERENCES platform_runs(run_id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'queued',
  current_step       TEXT,
  trigger_kind       TEXT NOT NULL DEFAULT 'manual',
  error_message      TEXT,
  metadata_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  node_runs_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_approval_json JSONB,
  outputs_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  CONSTRAINT platform_automation_runs_definition_revision_fk
    FOREIGN KEY (automation_id, automation_revision)
    REFERENCES platform_automation_versions(automation_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT platform_automation_runs_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  CONSTRAINT platform_automation_runs_trigger_kind_check
    CHECK (trigger_kind IN ('manual', 'schedule', 'agent'))
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace_started
  ON platform_automation_runs (workspace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_scheduled_task_started
  ON platform_automation_runs (scheduled_task_id, started_at);

INSERT INTO platform_schema_migrations (migration_id)
VALUES ('001_init_postgis')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
