# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 开发基础设施关闭命令
#
#   文件:       stop-infra.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
& docker compose -f $Compose down
if ($LASTEXITCODE -ne 0) { throw 'Docker 基础设施未能完整关闭。' }
