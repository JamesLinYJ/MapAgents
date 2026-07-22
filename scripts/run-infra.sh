#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 开发基础设施托管命令
#
#   文件:       run-infra.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 容器生命周期与日志订阅解耦；日志断线只重连，不伪造基础设施退出。
# --------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/compose/docker-compose.dev.yml"
cleanup() { docker compose -f "$COMPOSE" down; }
trap cleanup EXIT INT TERM
docker compose -f "$COMPOSE" up -d --wait
docker compose -f "$COMPOSE" exec -T postgis psql -U geo_agent -d geo_agent -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_better_auth_admin.sql
while true; do
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if docker compose -f "$COMPOSE" logs --follow --no-color --since "$since"; then
    log_exit_code=0
  else
    log_exit_code=$?
  fi
  echo "Docker 基础设施日志订阅已断开（退出码 ${log_exit_code}），1 秒后重新连接。" >&2
  sleep 1
done
