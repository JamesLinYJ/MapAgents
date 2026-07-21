# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows 本地开发进程入口
#
#   文件:       dev.ps1
#
#   日期:       2026年06月15日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Action = 'start',

    [ValidateSet('all', 'infra', 'worker', 'api', 'web')]
    [string]$Service = 'all',

    [ValidateRange(10, 5000)]
    [int]$Tail = 80,

    [switch]$OpenBrowser,
    [switch]$KeepPostgis,
    [switch]$FollowLogs
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root
. (Join-Path $Root 'scripts\dev-environment.ps1')
Initialize-GeoForgeDevEnvironment -ProjectRoot $Root

if ($Action -in @('start', 'restart')) {
    npm run build --workspace @geo-agent-platform/shared-types
    if ($LASTEXITCODE -ne 0) { throw '共享协议包构建失败。' }
}

$ProcessCompose = & (Join-Path $Root 'scripts\install-process-compose.ps1')
$Config = Join-Path $Root 'config\process-compose.windows.yaml'
$TokenFile = $env:PROCESS_COMPOSE_TOKEN_FILE
$Port = [int]$env:PROCESS_COMPOSE_PORT
$Address = '127.0.0.1'
$AllServices = @('infra', 'worker', 'api', 'web')
$SupervisorLogFile = [IO.Path]::GetFullPath($env:PROCESS_COMPOSE_LOG_FILE)
$SupervisorLaunchOut = Join-Path (Split-Path -Parent $SupervisorLogFile) 'process-compose-launch.stdout.log'
$SupervisorLaunchError = Join-Path (Split-Path -Parent $SupervisorLogFile) 'process-compose-launch.stderr.log'

function Invoke-ProcessComposeClient {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $ProcessCompose --address $Address --port $Port --token-file $TokenFile @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Process Compose 命令失败（exit $LASTEXITCODE）。" }
}

function Test-ProcessCompose {
    try {
        $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
        $Response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Headers @{ 'X-PC-Token-Key' = $Token } -Uri "http://$Address`:$Port/live"
        return $Response.StatusCode -eq 200
    } catch { return $false }
}

function Protect-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw 'Process Compose 参数包含非法双引号。' }
    return '"' + $Value + '"'
}

function Wait-ProcessCompose {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$SupervisorProcess,
        [int]$TimeoutSeconds = 20
    )
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-ProcessCompose) { return }
        if ($SupervisorProcess.HasExited) {
            $Details = @(
                Get-Content -LiteralPath $SupervisorLaunchError -Tail 30 -ErrorAction SilentlyContinue
                Get-Content -LiteralPath $SupervisorLaunchOut -Tail 30 -ErrorAction SilentlyContinue
            ) | Where-Object { $_ }
            $Suffix = if ($Details.Count) { "`n$($Details -join "`n")" } else { '' }
            throw "Process Compose 启动进程提前退出（exit $($SupervisorProcess.ExitCode)）。$Suffix"
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $Deadline)

    Stop-Process -Id $SupervisorProcess.Id -Force -ErrorAction SilentlyContinue
    throw "Process Compose 未在 $TimeoutSeconds 秒内开放控制接口。"
}

function Start-ProcessComposeSupervisor {
    param([string]$Target)
    Assert-StartupPortsAvailable $Target
    $Targets = if ($Target -eq 'all') { @() } else { @($Target) }
    $Arguments = @(
        '--address', $Address,
        '--port', [string]$Port,
        '--token-file', (Protect-NativeArgument $TokenFile),
        '--ordered-shutdown',
        '--log-file', (Protect-NativeArgument $SupervisorLogFile),
        '--log-no-color',
        '-f', (Protect-NativeArgument $Config),
        'up'
    ) + $Targets + @('--disable-dotenv', '--keep-project', '--tui=false')
    $SupervisorProcess = Start-Process -FilePath $ProcessCompose `
        -ArgumentList $Arguments `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $SupervisorLaunchOut `
        -RedirectStandardError $SupervisorLaunchError `
        -WindowStyle Hidden `
        -PassThru
    Wait-ProcessCompose -SupervisorProcess $SupervisorProcess
}

function Assert-StartupPortsAvailable {
    param([string]$Target)
    $Ports = [ordered]@{ 'Process Compose 控制面' = $Port }
    if ($Target -in @('all', 'web', 'api', 'worker', 'infra')) {
        $Ports['PostGIS'] = [int]$env:POSTGIS_PORT
        $Ports['Martin'] = [int]$env:MARTIN_PORT
        $Ports['TiTiler'] = [int]$env:TITILER_PORT
    }
    if ($Target -in @('all', 'web', 'api', 'worker')) { $Ports['Worker'] = [int]$env:WORKER_PORT }
    if ($Target -in @('all', 'web', 'api')) { $Ports['API'] = [int]$env:API_PORT }
    if ($Target -in @('all', 'web')) { $Ports['Web'] = [int]$env:WEB_DEV_PORT }

    foreach ($Entry in $Ports.GetEnumerator()) {
        $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Entry.Value -ErrorAction SilentlyContinue)
        if (-not $Listeners.Count) { continue }
        $ProcessIds = $Listeners.OwningProcess | Sort-Object -Unique
        throw "$($Entry.Key) 端口 $($Entry.Value) 已被进程 $($ProcessIds -join ', ') 占用。请先关闭旧进程；GeoForge 不会把外部进程误认成受监督服务。"
    }
}

function Start-GeoForge {
    param([string]$Target)
    if (-not (Test-ProcessCompose)) {
        Start-ProcessComposeSupervisor $Target
    } else {
        $Targets = if ($Target -eq 'all') { $AllServices } else { @($Target) }
        foreach ($Name in $Targets) { Invoke-ProcessComposeClient process start $Name }
    }
    Write-Host "GeoForge 由 Process Compose 管理：http://$Address`:$Port" -ForegroundColor Green
}

function Stop-GeoForge {
    param([string]$Target)
    if (-not (Test-ProcessCompose)) { Write-Host 'Process Compose 未运行。' -ForegroundColor DarkGray; return }
    if ($Target -eq 'all' -and -not $KeepPostgis) {
        Invoke-ProcessComposeClient down
        return
    }
    $Targets = if ($Target -eq 'all') { @('web', 'api', 'worker') } else { @($Target) }
    foreach ($Name in $Targets) { Invoke-ProcessComposeClient process stop $Name }
    if ($Target -eq 'all' -and -not $KeepPostgis) { Invoke-ProcessComposeClient process stop infra }
}

function Restart-GeoForge {
    param([string]$Target)
    if (-not (Test-ProcessCompose)) { Start-GeoForge $Target; return }
    if ($Target -eq 'all') {
        foreach ($Name in @('web', 'api', 'worker', 'infra')) { Invoke-ProcessComposeClient process stop $Name }
        foreach ($Name in $AllServices) { Invoke-ProcessComposeClient process start $Name }
        return
    }
    Invoke-ProcessComposeClient process restart $Target
}

function Show-GeoForgeStatus {
    if (-not (Test-ProcessCompose)) { Write-Host 'Process Compose: STOPPED' -ForegroundColor Yellow; return }
    Invoke-ProcessComposeClient list --output wide
    Write-Host "Ops Gateway: $(if (Test-Http "http://127.0.0.1:$($env:OPS_GATEWAY_PORT)/ops/health") { 'RUNNING' } else { 'NOT RUNNING (独立服务)' })"
    Write-Host "Terminal Broker: $(if (Test-Http "http://127.0.0.1:$($env:OPS_BROKER_PORT)/health") { 'RUNNING' } else { 'NOT RUNNING (独立服务)' })"
}

function Show-GeoForgeLogs {
    if (-not (Test-ProcessCompose)) { throw 'Process Compose 未运行。' }
    $Target = if ($Service -eq 'all') { $AllServices -join ',' } else { $Service }
    $Arguments = @('process', 'logs', $Target, '--tail', [string]$Tail)
    if ($FollowLogs) { $Arguments += '--follow' }
    Invoke-ProcessComposeClient @Arguments
}

function Test-Http {
    param([string]$Url)
    try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri $Url).StatusCode -eq 200 } catch { return $false }
}

switch ($Action) {
    'start' { Start-GeoForge $Service }
    'stop' { Stop-GeoForge $Service }
    'restart' { Restart-GeoForge $Service }
    'status' { Show-GeoForgeStatus }
    'logs' { Show-GeoForgeLogs }
}

if ($OpenBrowser -and $Action -in @('start', 'restart')) {
    Start-Process "http://127.0.0.1:$($env:WEB_DEV_PORT)"
    if (Test-Http "http://127.0.0.1:$($env:OPS_GATEWAY_PORT)/ops/health") {
        Start-Process "http://127.0.0.1:$($env:OPS_GATEWAY_PORT)/operations/"
    }
}
