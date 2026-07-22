#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 生产基础设施健康探针
#
#   文件:       check-infra-production.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/compose/docker-compose.prod.yml"
RUNNING="$(docker compose -f "$COMPOSE" ps --status running --services)"
for service in postgis martin titiler; do grep -qx "$service" <<<"$RUNNING"; done
docker compose -f "$COMPOSE" exec -T postgis psql -U "${POSTGRES_USER:-geo_agent}" -d "${POSTGRES_DB:-geo_agent}" -tAc "SELECT COUNT(*) = 5 FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'auth_user' AND column_name IN ('role','banned','ban_reason','ban_expires')) OR (table_name = 'auth_session' AND column_name = 'impersonated_by'))" | grep -qx t
