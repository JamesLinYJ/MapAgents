#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 本地开发进程入口
#
#   文件:       dev.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-22):
#     作者: OpenAI Codex
#     说明: 进程事实源迁移到 TypeScript 监督后台；无参数进入中文本地运维台。
# --------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

load_dotenv() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#${line%%[![:space:]]*}}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"; key="${key%${key##*[![:space:]]}}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "无效的 .env 变量名：$key" >&2; exit 2; }
    [[ -n "${!key+x}" ]] && continue
    value="${line#*=}"; value="${value#${value%%[![:space:]]*}}"; value="${value%${value##*[![:space:]]}}"
    if [[ ${#value} -ge 2 && (( "$value" == \"*\" ) || ( "$value" == \'*\' )) ]]; then value="${value:1:${#value}-2}"; fi
    export "$key=$value"
  done < "$file"
}

load_dotenv "$ROOT/.env"
export NODE_ENV="${NODE_ENV:-development}"
export GEOFORGE_ROOT="$ROOT"
export RUNTIME_ROOT="${RUNTIME_ROOT:-$ROOT/runtime}"
export POSTGIS_PORT="${POSTGIS_PORT:-55432}"
export MARTIN_PORT="${MARTIN_PORT:-3000}"
export TITILER_PORT="${TITILER_PORT:-8001}"
export WORKER_PORT="${WORKER_PORT:-8012}"
export API_PORT="${API_PORT:-8000}"
export WEB_DEV_PORT="${WEB_DEV_PORT:-5173}"
export WEB_STATIC_PORT="${WEB_STATIC_PORT:-4173}"
export WORKER_PYTHON="${WORKER_PYTHON:-python3}"
export API_HOST=127.0.0.1
export WEB_DEV_HOST=127.0.0.1
export DATABASE_URL="${DATABASE_URL:-postgresql://geo_agent:geo_agent@127.0.0.1:$POSTGIS_PORT/geo_agent}"
export WORKER_URL="${WORKER_URL:-http://127.0.0.1:$WORKER_PORT}"
export MARTIN_INTERNAL_URL="${MARTIN_INTERNAL_URL:-http://127.0.0.1:$MARTIN_PORT}"
export TITILER_INTERNAL_URL="${TITILER_INTERNAL_URL:-http://127.0.0.1:$TITILER_PORT}"
export APP_BASE_URL="${APP_BASE_URL:-http://127.0.0.1:$API_PORT}"
export WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:$WEB_DEV_PORT}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$APP_BASE_URL}"
export TRUSTED_ORIGINS="${TRUSTED_ORIGINS:-$WEB_BASE_URL,http://localhost:$WEB_DEV_PORT}"
export GEOFORGE_SUPERVISOR_TOKEN_FILE="${GEOFORGE_SUPERVISOR_TOKEN_FILE:-$RUNTIME_ROOT/ops/supervisor.token}"
export GEOFORGE_LOCAL_ROOT_SECRET_FILE="${GEOFORGE_LOCAL_ROOT_SECRET_FILE:-$RUNTIME_ROOT/ops/local-root.secret}"

SUPERVISOR_CLI="$ROOT/packages/operations-supervisor/dist/cli.js"
OPS_ROOT="$RUNTIME_ROOT/ops"
LAUNCH_LOG="$OPS_ROOT/supervisor-launch.log"

build_supervisor() {
  npm run build --workspace @geo-agent-platform/shared-types
  npm run build --workspace @geo-agent-platform/operations-supervisor
}

supervisor() { node "$SUPERVISOR_CLI" "$@" --root "$ROOT" --profile development; }
supervisor_live() { [[ -f "$SUPERVISOR_CLI" ]] && supervisor status --json >/dev/null 2>&1; }

start_supervisor() {
  supervisor_live && return 0
  mkdir -p "$OPS_ROOT"
  nohup node "$SUPERVISOR_CLI" daemon --root "$ROOT" --profile development >>"$LAUNCH_LOG" 2>&1 &
  local pid=$!
  for _ in $(seq 1 80); do
    supervisor_live && return 0
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || true
      echo 'TypeScript 监督器在 IPC 就绪前退出。' >&2
      tail -n 40 "$LAUNCH_LOG" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  echo 'TypeScript 监督器未在 20 秒内开放本机 IPC。' >&2
  return 1
}

ensure_supervisor() {
  [[ -f "$SUPERVISOR_CLI" ]] || build_supervisor
  start_supervisor
}

ACTION="${1:-default}"
[[ $# -gt 0 ]] && shift
SERVICE=all
if [[ $# -gt 0 && "$1" =~ ^(all|infra|worker|api|web)$ ]]; then SERVICE="$1"; shift; fi

case "$ACTION" in
  default)
    build_supervisor
    ensure_supervisor
    supervisor start all "$@"
    npm run console --workspace server ;;
  start|restart)
    build_supervisor
    ensure_supervisor
    supervisor "$ACTION" "$SERVICE" "$@" ;;
  stop)
    supervisor_live && supervisor stop "$SERVICE" "$@" || echo 'GeoForge 监督器未运行。' ;;
  status)
    supervisor_live && supervisor status "$@" || echo 'GeoForge 监督器未运行。' ;;
  logs)
    supervisor_live || { echo 'GeoForge 监督器未运行。' >&2; exit 1; }
    supervisor logs "$SERVICE" "$@" ;;
  console)
    build_supervisor
    ensure_supervisor
    npm run console --workspace server -- "$@" ;;
  shutdown)
    supervisor_live && supervisor shutdown "$@" || echo 'GeoForge 监督器未运行。' ;;
  *)
    echo '用法：./dev.sh [start|stop|restart|status|logs|console|shutdown] [all|infra|worker|api|web] [--json]' >&2
    exit 2 ;;
esac
