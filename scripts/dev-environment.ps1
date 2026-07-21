# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - 本地开发环境装配
#
#   文件:       dev-environment.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

function Initialize-GeoForgeDevEnvironment {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
    Import-GeoForgeDotEnv (Join-Path $ProjectRoot '.env')
    Set-GeoForgeDefault 'NODE_ENV' 'development'
    Set-GeoForgeDefault 'POSTGIS_PORT' '55432'
    Set-GeoForgeDefault 'MARTIN_PORT' '3000'
    Set-GeoForgeDefault 'TITILER_PORT' '8001'
    Set-GeoForgeValue 'API_HOST' '127.0.0.1'
    Set-GeoForgeDefault 'API_PORT' '8000'
    Set-GeoForgeDefault 'WORKER_PORT' '8012'
    Set-GeoForgeValue 'WEB_DEV_HOST' '127.0.0.1'
    Set-GeoForgeDefault 'WEB_DEV_PORT' '5173'
    Set-GeoForgeValue 'OPS_GATEWAY_HOST' '127.0.0.1'
    Set-GeoForgeDefault 'OPS_GATEWAY_PORT' '8020'
    Set-GeoForgeValue 'OPS_BROKER_HOST' '127.0.0.1'
    Set-GeoForgeDefault 'OPS_BROKER_PORT' '8021'
    Set-GeoForgeDefault 'OPS_WEB_PORT' '8022'
    Set-GeoForgeDefault 'PROCESS_COMPOSE_PORT' '8080'
    Set-GeoForgeDefault 'RUNTIME_ROOT' (Join-Path $ProjectRoot 'runtime')
    Set-GeoForgeValue 'RUNTIME_ROOT' (Resolve-GeoForgePath -Path $env:RUNTIME_ROOT -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'PROCESS_COMPOSE_LOG_FILE' (Join-Path $env:RUNTIME_ROOT 'ops\process-compose.log')
    Set-GeoForgeValue 'PROCESS_COMPOSE_LOG_FILE' (Resolve-GeoForgePath -Path $env:PROCESS_COMPOSE_LOG_FILE -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'PROC_COMP_CONFIG' (Join-Path $env:RUNTIME_ROOT 'ops\process-compose-config')
    Set-GeoForgeValue 'PROC_COMP_CONFIG' (Resolve-GeoForgePath -Path $env:PROC_COMP_CONFIG -BasePath $ProjectRoot)
    Set-GeoForgeValue 'WORKER_PYTHON' (Resolve-GeoForgePython -ProjectRoot $ProjectRoot)
    Set-GeoForgeDefault 'WORKER_SHARED_SECRET' 'development-only-worker-shared-secret-change-before-production'
    Set-GeoForgeDefault 'BETTER_AUTH_SECRET' 'development-only-better-auth-secret-change-before-production'
    Set-GeoForgeDefault 'BETTER_AUTH_ALLOW_SIGN_UP' 'true'
    Set-GeoForgeDefault 'BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION' 'false'
    Set-GeoForgeDefault 'BETTER_AUTH_MIN_PASSWORD_LENGTH' '12'
    Set-GeoForgeDefault 'CSRF_HEADER_NAME' 'x-geoforge-csrf'
    Set-GeoForgeDefault 'OPS_WINDOWS_SHELL' ((Get-Command pwsh -ErrorAction Stop).Source)
    Set-GeoForgeDefault 'OPS_WORKSPACE_ROOT' $ProjectRoot
    Set-GeoForgeValue 'OPS_WORKSPACE_ROOT' (Resolve-GeoForgePath -Path $env:OPS_WORKSPACE_ROOT -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'OPS_STATIC_ROOT' (Join-Path $ProjectRoot 'apps\operations\dist')
    Set-GeoForgeValue 'OPS_STATIC_ROOT' (Resolve-GeoForgePath -Path $env:OPS_STATIC_ROOT -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'OPS_TERMINAL_SPOOL_ROOT' (Join-Path $env:RUNTIME_ROOT 'ops\terminal-spool')
    Set-GeoForgeValue 'OPS_TERMINAL_SPOOL_ROOT' (Resolve-GeoForgePath -Path $env:OPS_TERMINAL_SPOOL_ROOT -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'OPS_MASTER_KEYRING_FILE' (Join-Path $env:RUNTIME_ROOT 'ops\keyring.json')
    Set-GeoForgeValue 'OPS_MASTER_KEYRING_FILE' (Resolve-GeoForgePath -Path $env:OPS_MASTER_KEYRING_FILE -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'OPS_ACTIVE_KEY_ID' 'dev-1'
    Set-GeoForgeDefault 'PROCESS_COMPOSE_TOKEN_FILE' (Join-Path $env:RUNTIME_ROOT 'ops\process-compose.token')
    Set-GeoForgeValue 'PROCESS_COMPOSE_TOKEN_FILE' (Resolve-GeoForgePath -Path $env:PROCESS_COMPOSE_TOKEN_FILE -BasePath $ProjectRoot)
    Set-GeoForgeValue 'DATABASE_URL' "postgresql://geo_agent:geo_agent@127.0.0.1:$($env:POSTGIS_PORT)/geo_agent"
    Set-GeoForgeValue 'WORKER_URL' "http://127.0.0.1:$($env:WORKER_PORT)"
    Set-GeoForgeValue 'MARTIN_INTERNAL_URL' "http://127.0.0.1:$($env:MARTIN_PORT)"
    Set-GeoForgeValue 'TITILER_INTERNAL_URL' "http://127.0.0.1:$($env:TITILER_PORT)"
    Set-GeoForgeValue 'API_PROXY_TARGET' "http://127.0.0.1:$($env:API_PORT)"
    Set-GeoForgeValue 'APP_BASE_URL' "http://127.0.0.1:$($env:API_PORT)"
    Set-GeoForgeValue 'WEB_BASE_URL' "http://127.0.0.1:$($env:WEB_DEV_PORT)"
    Set-GeoForgeValue 'BETTER_AUTH_URL' $env:APP_BASE_URL
    Set-GeoForgeValue 'VITE_API_BASE_URL' '/'
    Set-GeoForgeValue 'OPS_PUBLIC_BASE_URL' "http://127.0.0.1:$($env:OPS_GATEWAY_PORT)"
    Set-GeoForgeValue 'OPS_GATEWAY_URL' $env:OPS_PUBLIC_BASE_URL
    Set-GeoForgeValue 'OPS_BROKER_URL' "http://127.0.0.1:$($env:OPS_BROKER_PORT)"
    Set-GeoForgeValue 'PROCESS_COMPOSE_URL' "http://127.0.0.1:$($env:PROCESS_COMPOSE_PORT)"
    Set-GeoForgeValue 'OPS_ALLOWED_ORIGINS' "$($env:OPS_PUBLIC_BASE_URL),http://localhost:$($env:OPS_GATEWAY_PORT),http://127.0.0.1:$($env:OPS_WEB_PORT),http://localhost:$($env:OPS_WEB_PORT)"
    Set-GeoForgeValue 'TRUSTED_ORIGINS' "$($env:WEB_BASE_URL),http://localhost:$($env:WEB_DEV_PORT),$($env:OPS_PUBLIC_BASE_URL)"
    Set-GeoForgeValue 'GEOFORGE_ROOT' $ProjectRoot
    Set-GeoForgeDefault 'SEED_LAYERS_DIR' (Join-Path $ProjectRoot 'infra\seeds\layers')
    Set-GeoForgeValue 'SEED_LAYERS_DIR' (Resolve-GeoForgePath -Path $env:SEED_LAYERS_DIR -BasePath $ProjectRoot)
    Set-GeoForgeDefault 'ENABLED_TOOL_PROVIDERS' 'geo-platform-chart,geo-platform-geocode,geo-platform-plan,geo-platform-developer-tools,geo-platform-spatial,geo-platform-routing,geo-platform-meteorology,geo-platform-scheduled-wake-up'
    Set-GeoForgeDefault 'DEVELOPER_TOOL_ALLOWED_ROOTS' "$ProjectRoot;$($env:RUNTIME_ROOT)"

    $OpsRoot = Join-Path $env:RUNTIME_ROOT 'ops'
    New-Item -ItemType Directory -Force -Path $OpsRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $env:PROC_COMP_CONFIG | Out-Null
    New-Item -ItemType Directory -Force -Path $env:OPS_TERMINAL_SPOOL_ROOT | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:PROCESS_COMPOSE_LOG_FILE) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:OPS_MASTER_KEYRING_FILE) | Out-Null
    Ensure-GeoForgeSecretFile -Path $env:PROCESS_COMPOSE_TOKEN_FILE -Bytes 32
    $SecretsPath = Join-Path $OpsRoot 'dev-secrets.json'
    if (-not (Test-Path -LiteralPath $SecretsPath)) {
        $Secrets = @{
            broker = New-GeoForgeSecret 48
            recovery = New-GeoForgeSecret 48
        }
        $Secrets | ConvertTo-Json | Set-Content -LiteralPath $SecretsPath -Encoding utf8NoBOM
    }
    $Secrets = Get-Content -LiteralPath $SecretsPath -Raw | ConvertFrom-Json
    Set-GeoForgeValue 'OPS_BROKER_SHARED_SECRET' ([string]$Secrets.broker)
    Set-GeoForgeValue 'OPS_RECOVERY_SECRET' ([string]$Secrets.recovery)
    if (-not (Test-Path -LiteralPath $env:OPS_MASTER_KEYRING_FILE)) {
        @{ version = 1; keys = @(@{ id = 'dev-1'; status = 'active'; keyBase64 = New-GeoForgeSecret 32 }) } |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:OPS_MASTER_KEYRING_FILE -Encoding utf8NoBOM
    }
}

function Import-GeoForgeDotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($Line in Get-Content -LiteralPath $Path) {
        $Text = $Line.Trim()
        if (-not $Text -or $Text.StartsWith('#') -or -not $Text.Contains('=')) { continue }
        $Parts = $Text.Split('=', 2)
        $Name = $Parts[0].Trim()
        $Value = $Parts[1].Trim().Trim('"').Trim("'")
        if ($Name -match '^[A-Za-z_][A-Za-z0-9_]*$' -and -not [Environment]::GetEnvironmentVariable($Name, 'Process')) {
            [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
        }
    }
}

function Set-GeoForgeDefault { param([string]$Name, [string]$Value); if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) { Set-GeoForgeValue $Name $Value } }
function Set-GeoForgeValue { param([string]$Name, [string]$Value); [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }
function Resolve-GeoForgePath { param([string]$Path, [string]$BasePath); if (-not $Path) { throw '路径配置不能为空。' }; [IO.Path]::GetFullPath($Path, $BasePath) }
function New-GeoForgeSecret { param([int]$Bytes); $Buffer = [byte[]]::new($Bytes); [Security.Cryptography.RandomNumberGenerator]::Fill($Buffer); [Convert]::ToBase64String($Buffer) }
function Ensure-GeoForgeSecretFile { param([string]$Path, [int]$Bytes); New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; if (-not (Test-Path -LiteralPath $Path)) { New-GeoForgeSecret $Bytes | Set-Content -LiteralPath $Path -Encoding ascii -NoNewline } }
function Resolve-GeoForgePython {
    param([string]$ProjectRoot)
    $Configured = [Environment]::GetEnvironmentVariable('WORKER_PYTHON', 'Process')
    if ($Configured) {
        $ConfiguredPath = Resolve-GeoForgePath -Path $Configured -BasePath $ProjectRoot
        if (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf) { return $ConfiguredPath }
        $ConfiguredCommand = Get-Command $Configured -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ConfiguredCommand) { return $ConfiguredCommand.Source }
        throw 'WORKER_PYTHON 指向的 Python 解释器不存在。'
    }
    $Command = Get-Command python.exe -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\WindowsApps\python.exe' } | Select-Object -First 1
    if (-not $Command) { throw '未找到 Python；请设置 WORKER_PYTHON。' }
    return $Command.Source
}
