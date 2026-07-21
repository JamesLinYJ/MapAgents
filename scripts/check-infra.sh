#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 基础设施健康探针
#
#   文件:       check-infra.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/compose/docker-compose.dev.yml"
RUNNING="$(docker compose -f "$COMPOSE" ps --status running --services)"
for service in postgis martin titiler; do grep -qx "$service" <<<"$RUNNING"; done
docker compose -f "$COMPOSE" exec -T postgis psql -U geo_agent -d geo_agent -tAc "SELECT to_regclass('public.platform_terminal_sessions') IS NOT NULL" | grep -qx t
