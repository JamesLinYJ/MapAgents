#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 基础设施健康探针
#
#   文件:       check-infra.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 持续探针只检查容器存活；schema migration 由启动命令硬失败保证。
# --------------------------------------------------------------------------

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/compose/docker-compose.dev.yml"
RUNNING="$(docker compose -f "$COMPOSE" ps --status running --services)"
for service in postgis martin titiler; do grep -qx "$service" <<<"$RUNNING"; done
