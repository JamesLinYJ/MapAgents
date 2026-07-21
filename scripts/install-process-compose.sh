#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Linux Process Compose 固定版本安装器
#
#   文件:       install-process-compose.sh
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="1.120.0"
export PROC_COMP_CONFIG="${PROC_COMP_CONFIG:-$ROOT/runtime/ops/process-compose-config}"
mkdir -p "$PROC_COMP_CONFIG"
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64"; EXPECTED="3792e1ed9f383832eb2362154444e8564fbc8e7e8e7cff8754c68aea5eca086e" ;;
  aarch64|arm64) ARCH="arm64"; EXPECTED="c5f4fcfc63e849279ac531bce2394a918fb28746339088a7d3d02bb5fb218a68" ;;
  *) echo "Process Compose only supports configured Linux amd64/arm64 architectures." >&2; exit 1 ;;
esac
TOOL_ROOT="$ROOT/runtime/tools/process-compose/$VERSION"
EXECUTABLE="$TOOL_ROOT/process-compose"
if [[ -x "$EXECUTABLE" ]]; then
  INSTALLED="$($EXECUTABLE version --short | sed 's/^v//')"
  [[ "$INSTALLED" == "$VERSION" ]] || { echo "Installed Process Compose version mismatch: $INSTALLED" >&2; exit 1; }
  printf '%s\n' "$EXECUTABLE"
  exit 0
fi
mkdir -p "$TOOL_ROOT"
ARCHIVE="$TOOL_ROOT/process-compose_linux_${ARCH}.tar.gz"
URL="https://github.com/F1bonacc1/process-compose/releases/download/v${VERSION}/process-compose_linux_${ARCH}.tar.gz"
curl --fail --location --silent --show-error "$URL" --output "$ARCHIVE"
ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || { rm -f "$ARCHIVE"; echo "Process Compose SHA256 verification failed." >&2; exit 1; }
tar -xzf "$ARCHIVE" -C "$TOOL_ROOT"
rm -f "$ARCHIVE"
chmod 0755 "$EXECUTABLE"
INSTALLED="$($EXECUTABLE version --short | sed 's/^v//')"
[[ "$INSTALLED" == "$VERSION" ]] || { echo "Process Compose binary version mismatch: $INSTALLED" >&2; exit 1; }
printf '%s\n' "$EXECUTABLE"
