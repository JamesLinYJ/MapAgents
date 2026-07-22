# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows Docker 基础设施托管命令
#
#   文件:       run-infra.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 容器生命周期与日志订阅解耦；日志断线只重连，不伪造基础设施退出。
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
try {
    & docker compose -f $Compose up -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker 基础设施启动失败。' }
    & docker compose -f $Compose exec -T postgis psql -U geo_agent -d geo_agent -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_better_auth_admin.sql
    if ($LASTEXITCODE -ne 0) { throw 'Better Auth Admin Plugin migration 执行失败。' }
    while ($true) {
        $Since = [DateTime]::UtcNow.ToString('o')
        $LogExitCode = 0
        try {
            & docker compose -f $Compose logs --follow --no-color --since $Since
            $LogExitCode = $LASTEXITCODE
        } catch {
            $LogExitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
        }
        Write-Warning "Docker 基础设施日志订阅已断开（退出码 $LogExitCode），1 秒后重新连接。"
        Start-Sleep -Seconds 1
    }
} finally {
    & docker compose -f $Compose down
}
