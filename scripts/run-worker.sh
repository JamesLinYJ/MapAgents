#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux Worker 进程入口
#
#   文件:       run-worker.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 移除开发期 Uvicorn reload 子监督器，统一由 GeoForge 监督进程生命周期。
# --------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKER_PYTHON_VALUE="${WORKER_PYTHON:-}"
if [[ -z "$WORKER_PYTHON_VALUE" ]]; then
  echo 'Worker 启动失败：缺少 WORKER_PYTHON。' >&2
  exit 2
fi
if [[ "$WORKER_PYTHON_VALUE" == */* ]]; then
  if [[ ! -x "$WORKER_PYTHON_VALUE" ]]; then
    echo 'Worker 启动失败：WORKER_PYTHON 指向的解释器不存在或不可执行。' >&2
    exit 2
  fi
  PYTHON_COMMAND="$WORKER_PYTHON_VALUE"
else
  PYTHON_COMMAND="$(command -v -- "$WORKER_PYTHON_VALUE" || true)"
  if [[ -z "$PYTHON_COMMAND" ]]; then
    echo 'Worker 启动失败：WORKER_PYTHON 指向的解释器不存在。' >&2
    exit 2
  fi
fi

WORKER_PORT_VALUE="${WORKER_PORT:-}"
if [[ ! "$WORKER_PORT_VALUE" =~ ^[0-9]+$ ]] || (( WORKER_PORT_VALUE < 1 || WORKER_PORT_VALUE > 65535 )); then
  echo 'Worker 启动失败：WORKER_PORT 必须是 1 到 65535 之间的整数。' >&2
  exit 2
fi

arguments=(
  -m uvicorn
  worker_app.sidecar:app
  --app-dir apps/worker/src
  --host 127.0.0.1
  --port "$WORKER_PORT_VALUE"
)

if [[ "${NODE_ENV:-development}" == production ]]; then
  WORKER_PROCESSES_VALUE="${WORKER_PROCESSES:-}"
  if [[ ! "$WORKER_PROCESSES_VALUE" =~ ^[0-9]+$ ]] || (( WORKER_PROCESSES_VALUE < 1 || WORKER_PROCESSES_VALUE > 64 )); then
    echo 'Worker 启动失败：生产环境的 WORKER_PROCESSES 必须是 1 到 64 之间的整数。' >&2
    exit 2
  fi
  arguments+=(--workers "$WORKER_PROCESSES_VALUE")
fi

exec "$PYTHON_COMMAND" "${arguments[@]}"
