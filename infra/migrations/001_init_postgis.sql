-- +-------------------------------------------------------------------------
--
--   GeoForge Baseline Schema — 全新 PostGIS 数据库初始化
--
--   文件:       001_init_postgis.sql
--
--   用途:       创建全部核心表、索引、约束。
--               不包含旧登录/session 兼容代码。
--               应在首次部署或 reset 后作为第一步执行。
-- --------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS postgis;

-- ==========================================================================
-- Better Auth 认证表（auth_user / auth_session / auth_account / auth_verification）
-- ==========================================================================

CREATE TABLE IF NOT EXISTS auth_user (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  image           TEXT,
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
  user_id      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_session_token_unique ON auth_session (token);
CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session (user_id);

CREATE TABLE IF NOT EXISTS auth_account (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL,
  provider_id               TEXT NOT NULL,
  user_id                   TEXT NOT NULL,
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
  created_by_user_id TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_memberships (
  membership_id TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_memberships_member_role_unique
  ON platform_memberships (workspace_id, user_id, role);
CREATE INDEX IF NOT EXISTS idx_platform_memberships_workspace ON platform_memberships (workspace_id);
CREATE INDEX IF NOT EXISTS idx_platform_memberships_user ON platform_memberships (user_id);

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
  actor_user_id  TEXT,
  workspace_id   TEXT,
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
  run_id                TEXT NOT NULL,
  workspace_id          TEXT,
  created_by_user_id    TEXT,
  visibility            TEXT NOT NULL DEFAULT 'workspace',
  artifact_type         TEXT NOT NULL,
  name                  TEXT NOT NULL,
  uri                   TEXT NOT NULL,
  metadata_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  geojson_relative_path TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_artifacts_run_id ON platform_artifacts (run_id);

CREATE TABLE IF NOT EXISTS layers_metadata (
  layer_key     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  geometry_type TEXT NOT NULL,
  srid          INTEGER NOT NULL DEFAULT 4326,
  table_name    TEXT NOT NULL,
  description   TEXT NOT NULL,
  feature_count INTEGER,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  workspace_id        TEXT,
  created_by_user_id  TEXT,
  visibility          TEXT NOT NULL DEFAULT 'workspace',
  session_id          TEXT NOT NULL,
  thread_id           TEXT,
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
  dataset_id         TEXT NOT NULL,
  workspace_id       TEXT,
  created_by_user_id TEXT,
  session_id         TEXT NOT NULL,
  thread_id          TEXT,
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
