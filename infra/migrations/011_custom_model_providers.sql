-- 地理智能平台 - 受保护的自定义模型 Provider
--
-- Provider 配置是 PostgreSQL 结构化事实；API Key 只保存 AES-GCM 密文、
-- IV、认证标签和密钥版本，不允许落入通用 JSON 配置或 Renderer 快照。

BEGIN;

CREATE TABLE IF NOT EXISTS platform_model_providers (
  provider_id             TEXT PRIMARY KEY,
  display_name            TEXT NOT NULL,
  base_url                TEXT NOT NULL,
  protocol                TEXT NOT NULL CHECK (protocol IN ('responses', 'chat_completions')),
  models_json             JSONB NOT NULL,
  default_model           TEXT NOT NULL,
  tool_schema_mode        TEXT NOT NULL CHECK (tool_schema_mode IN ('strict', 'compatible')),
  network_access          TEXT NOT NULL CHECK (network_access IN ('public', 'loopback')),
  api_key_ciphertext      TEXT,
  api_key_iv              TEXT,
  api_key_auth_tag        TEXT,
  credential_key_version  TEXT,
  created_by_user_id      TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT,
  last_validated_at       TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_model_providers_credential_completeness_check CHECK (
    (api_key_ciphertext IS NULL AND api_key_iv IS NULL AND api_key_auth_tag IS NULL AND credential_key_version IS NULL)
    OR
    (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_auth_tag IS NOT NULL AND credential_key_version IS NOT NULL)
  ),
  CONSTRAINT platform_model_providers_models_array_check CHECK (
    jsonb_typeof(models_json) = 'array' AND jsonb_array_length(models_json) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_platform_model_providers_created_by
  ON platform_model_providers (created_by_user_id);

COMMIT;
