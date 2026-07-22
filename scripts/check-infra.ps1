# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 基础设施健康探针
#
#   文件:       check-infra.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 持续探针只检查容器存活；schema migration 由启动命令硬失败保证。
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
$Running = @(& docker compose -f $Compose ps --status running --services)
if ($LASTEXITCODE -ne 0 -or @('postgis', 'martin', 'titiler').Where({ $_ -notin $Running }).Count -gt 0) { exit 1 }
exit 0
