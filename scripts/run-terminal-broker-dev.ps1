# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - 本地 Terminal Broker 前台启动器
#
#   文件:       run-terminal-broker-dev.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $Root
. (Join-Path $Root 'scripts\dev-environment.ps1')
Initialize-GeoForgeDevEnvironment -ProjectRoot $Root
npm run build --workspace @geo-agent-platform/shared-types
if ($LASTEXITCODE -ne 0) { throw '共享协议包构建失败。' }
npm exec -- tsx watch server/src/operations/terminalBrokerEntry.ts
