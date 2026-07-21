#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 开发基础设施托管命令
#
#   文件:       run-infra.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/compose/docker-compose.dev.yml"
cleanup() { docker compose -f "$COMPOSE" down; }
trap cleanup EXIT INT TERM
docker compose -f "$COMPOSE" up -d --wait
docker compose -f "$COMPOSE" exec -T postgis psql -U geo_agent -d geo_agent -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_operations_terminal.sql
docker compose -f "$COMPOSE" logs --follow --no-color
