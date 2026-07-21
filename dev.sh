#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux 本地开发进程入口
#
#   文件:       dev.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PC="$($ROOT/scripts/install-process-compose.sh)"
CONFIG="$ROOT/config/process-compose.linux.yaml"
TOKEN_FILE="${PROCESS_COMPOSE_TOKEN_FILE:-$ROOT/runtime/ops/process-compose.token}"
PORT="${PROCESS_COMPOSE_PORT:-8080}"
ACTION="${1:-start}"
SERVICE="${2:-all}"
case "$SERVICE" in all|infra|worker|api|web) ;; *) echo "Unknown service: $SERVICE" >&2; exit 2 ;; esac
if [[ "$ACTION" == start || "$ACTION" == restart ]]; then
  npm run build --workspace @geo-agent-platform/shared-types
fi
mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ ! -s "$TOKEN_FILE" ]]; then openssl rand -base64 32 > "$TOKEN_FILE"; chmod 0600 "$TOKEN_FILE"; fi
export GEOFORGE_ROOT="$ROOT"
export RUNTIME_ROOT="${RUNTIME_ROOT:-$ROOT/runtime}"
export PROC_COMP_CONFIG="${PROC_COMP_CONFIG:-$RUNTIME_ROOT/ops/process-compose-config}"
export WORKER_PYTHON="${WORKER_PYTHON:-python3}"
export WORKER_PORT="${WORKER_PORT:-8012}"
export API_PORT="${API_PORT:-8000}"
export WEB_DEV_PORT="${WEB_DEV_PORT:-5173}"
export PROCESS_COMPOSE_TOKEN_FILE="$TOKEN_FILE"
PROCESS_COMPOSE_LOG_FILE="${PROCESS_COMPOSE_LOG_FILE:-$RUNTIME_ROOT/ops/process-compose.log}"
PROCESS_COMPOSE_LAUNCH_LOG="${PROCESS_COMPOSE_LAUNCH_LOG:-$RUNTIME_ROOT/ops/process-compose-launch.log}"
mkdir -p "$PROC_COMP_CONFIG" "$(dirname "$PROCESS_COMPOSE_LOG_FILE")"
client() { "$PC" --address 127.0.0.1 --port "$PORT" --token-file "$TOKEN_FILE" "$@"; }
live() { curl --fail --silent -H "X-PC-Token-Key: $(tr -d '\r\n' < "$TOKEN_FILE")" "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; }
start_supervisor() {
  local target="$1"
  local -a targets=()
  [[ "$target" != all ]] && targets+=("$target")
  nohup "$PC" --address 127.0.0.1 --port "$PORT" --token-file "$TOKEN_FILE" \
    --ordered-shutdown --log-file "$PROCESS_COMPOSE_LOG_FILE" --log-no-color \
    -f "$CONFIG" up "${targets[@]}" --disable-dotenv --keep-project --tui=false \
    >>"$PROCESS_COMPOSE_LAUNCH_LOG" 2>&1 &
  local supervisor_pid=$!
  for _ in $(seq 1 80); do
    live && return 0
    if ! kill -0 "$supervisor_pid" 2>/dev/null; then
      wait "$supervisor_pid" || true
      echo "Process Compose exited before its control API became ready." >&2
      tail -n 40 "$PROCESS_COMPOSE_LAUNCH_LOG" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  kill "$supervisor_pid" 2>/dev/null || true
  wait "$supervisor_pid" 2>/dev/null || true
  echo "Process Compose control API did not become ready within 20 seconds." >&2
  return 1
}
case "$ACTION" in
  start)
    if live; then
      if [[ "$SERVICE" == all ]]; then for name in infra worker api web; do client process start "$name"; done
      else client process start "$SERVICE"
      fi
    else start_supervisor "$SERVICE"
    fi ;;
  stop) if live; then [[ "$SERVICE" == all ]] && client down || client process stop "$SERVICE"; else echo "Process Compose: STOPPED"; fi ;;
  restart)
    if [[ "$SERVICE" == all ]]; then live && client down; start_supervisor all
    elif live; then client process restart "$SERVICE"
    else start_supervisor "$SERVICE"
    fi ;;
  status) live && client list --output wide || echo "Process Compose: STOPPED" ;;
  logs) client process logs "$([[ "$SERVICE" == all ]] && echo infra,worker,api,web || echo "$SERVICE")" --tail "${TAIL:-80}" ${FOLLOW_LOGS:+--follow} ;;
  *) echo "Usage: ./dev.sh {start|stop|restart|status|logs} {all|infra|worker|api|web}" >&2; exit 2 ;;
esac
