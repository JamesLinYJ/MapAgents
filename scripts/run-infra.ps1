# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows Docker 基础设施托管命令
#
#   文件:       run-infra.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
try {
    & docker compose -f $Compose up -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker 基础设施启动失败。' }
    & docker compose -f $Compose exec -T postgis psql -U geo_agent -d geo_agent -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_operations_terminal.sql
    if ($LASTEXITCODE -ne 0) { throw '运维数据库 migration 执行失败。' }
    & docker compose -f $Compose logs --follow --no-color
    if ($LASTEXITCODE -ne 0) { throw 'Docker 基础设施日志跟随异常退出。' }
} finally {
    & docker compose -f $Compose down
}
