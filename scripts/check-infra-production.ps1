# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 生产基础设施健康探针
#
#   文件:       check-infra-production.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.prod.yml'
$DatabaseUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'geo_agent' }
$DatabaseName = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'geo_agent' }
$Running = @(& docker compose -f $Compose ps --status running --services)
if ($LASTEXITCODE -ne 0 -or @('postgis', 'martin', 'titiler').Where({ $_ -notin $Running }).Count -gt 0) { exit 1 }
$SchemaReady = (& docker compose -f $Compose exec -T postgis psql -U $DatabaseUser -d $DatabaseName -tAc "SELECT COUNT(*) = 5 FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'auth_user' AND column_name IN ('role','banned','ban_reason','ban_expires')) OR (table_name = 'auth_session' AND column_name = 'impersonated_by'))").Trim()
if ($LASTEXITCODE -ne 0 -or $SchemaReady -ne 't') { exit 1 }
exit 0
