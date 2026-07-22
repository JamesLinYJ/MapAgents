# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 基础设施健康探针
#
#   文件:       check-infra.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Compose = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
$Running = @(& docker compose -f $Compose ps --status running --services)
if ($LASTEXITCODE -ne 0 -or @('postgis', 'martin', 'titiler').Where({ $_ -notin $Running }).Count -gt 0) { exit 1 }
$SchemaReady = (& docker compose -f $Compose exec -T postgis psql -U geo_agent -d geo_agent -tAc "SELECT COUNT(*) = 5 FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'auth_user' AND column_name IN ('role','banned','ban_reason','ban_expires')) OR (table_name = 'auth_session' AND column_name = 'impersonated_by'))").Trim()
if ($LASTEXITCODE -ne 0 -or $SchemaReady -ne 't') { exit 1 }
exit 0
