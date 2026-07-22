# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 生产基础设施托管命令
#
#   文件:       run-infra-production.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.prod.yml'
$DatabaseUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'geo_agent' }
$DatabaseName = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'geo_agent' }
try {
    & docker compose -f $Compose up -d --wait
    if ($LASTEXITCODE -ne 0) { throw '生产 Docker 基础设施启动失败。' }
    & docker compose -f $Compose exec -T postgis psql -U $DatabaseUser -d $DatabaseName -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_better_auth_admin.sql
    if ($LASTEXITCODE -ne 0) { throw 'Better Auth Admin Plugin migration 执行失败。' }
    & docker compose -f $Compose logs --follow --no-color
    if ($LASTEXITCODE -ne 0) { throw '生产 Docker 基础设施日志跟随异常退出。' }
} finally {
    & docker compose -f $Compose down
}
