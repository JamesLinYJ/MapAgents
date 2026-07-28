# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 本地开发进程入口
#
#   文件:       dev.ps1
#
#   日期:       2026年06月15日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-22):
#     作者: OpenAI Codex
#     说明: 进程事实源迁移到 TypeScript 监督后台；无参数进入中文本地运维台。
#
#   维护记录 (2026-07-27):
#     作者: OpenAI Codex
#     说明: 开发入口在启动 API 或 Agent CLI 前构建跨端对话展示包。
#
#   维护记录 (2026-07-27):
#     作者: OpenAI Codex
#     说明: 运行中的 Web 开发服务改用原位增量构建，避免清空 dist 触发模块加载失败。
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('default', 'start', 'stop', 'restart', 'status', 'logs', 'console', 'agent', 'shutdown')]
    [string]$Action = 'default',

    [Parameter(Position = 1)]
    [ValidateSet('all', 'infra', 'worker', 'api', 'web')]
    [string]$Service = 'all',

    [ValidateRange(0, 10000)]
    [int]$Tail = 80,

    [switch]$OpenBrowser,
    [switch]$KeepPostgis,
    [switch]$FollowLogs,
    [switch]$Json,
    [switch]$Check,

    [string]$AgentPrompt,
    [ValidateSet('auto', 'plan')]
    [string]$AgentMode = 'auto',
    [string]$AgentProvider,
    [string]$AgentModel,
    [string]$AgentThread,
    [ValidateRange(5, 3600)]
    [int]$AgentTimeout = 600,
    [switch]$NoReasoning
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root
. (Join-Path $Root 'scripts\dev-environment.ps1')
Initialize-GeoForgeDevEnvironment -ProjectRoot $Root

$SupervisorCli = Join-Path $Root 'packages\operations-supervisor\dist\cli.js'
$OpsRoot = Join-Path $env:RUNTIME_ROOT 'ops'
$LaunchOut = Join-Path $OpsRoot 'supervisor-launch.stdout.log'
$LaunchError = Join-Path $OpsRoot 'supervisor-launch.stderr.log'
$Node = (Get-Command node.exe -ErrorAction Stop).Source

function Invoke-GeoForgeBuild {
    npm run build:dev --workspace '@geo-agent-platform/shared-types'
    if ($LASTEXITCODE -ne 0) { throw '共享协议包构建失败。' }
    npm run build:dev --workspace '@geo-agent-platform/conversation-presentation'
    if ($LASTEXITCODE -ne 0) { throw '跨端对话展示包构建失败。' }
    npm run build:dev --workspace '@geo-agent-platform/operations-supervisor'
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript 监督器构建失败。' }
}

function Invoke-Supervisor {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Node $SupervisorCli @Arguments --root $Root --profile development
    if ($LASTEXITCODE -ne 0) { throw "GeoForge 监督命令失败（exit $LASTEXITCODE）。" }
}

function Test-Supervisor {
    if (-not (Test-Path -LiteralPath $SupervisorCli -PathType Leaf)) { return $false }
    try {
        & $Node $SupervisorCli status --root $Root --profile development --json *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Protect-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) { throw '启动参数包含非法双引号。' }
    return '"' + $Value + '"'
}

function Start-Supervisor {
    if (Test-Supervisor) { return }
    New-Item -ItemType Directory -Force -Path $OpsRoot | Out-Null
    $Arguments = @(
        (Protect-NativeArgument $SupervisorCli),
        'daemon',
        '--root', (Protect-NativeArgument $Root),
        '--profile', 'development'
    )
    $Process = Start-Process -FilePath $Node `
        -ArgumentList $Arguments `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $LaunchOut `
        -RedirectStandardError $LaunchError `
        -WindowStyle Hidden `
        -PassThru
    $Deadline = (Get-Date).AddSeconds(20)
    do {
        if (Test-Supervisor) { return }
        if ($Process.HasExited) {
            $Details = @(
                Get-Content -LiteralPath $LaunchError -Tail 40 -ErrorAction SilentlyContinue
                Get-Content -LiteralPath $LaunchOut -Tail 40 -ErrorAction SilentlyContinue
            ) | Where-Object { $_ }
            throw "TypeScript 监督器提前退出（exit $($Process.ExitCode)）。`n$($Details -join "`n")"
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $Deadline)
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw 'TypeScript 监督器未在 20 秒内开放本机 IPC。'
}

function Ensure-Supervisor {
    if (-not (Test-Path -LiteralPath $SupervisorCli -PathType Leaf)) { Invoke-GeoForgeBuild }
    Start-Supervisor
}

function Open-LocalConsole {
    Ensure-Supervisor
    $Arguments = @('run', 'console', '--workspace', 'geo-agent-server')
    if ($Check) { $Arguments += @('--', '--check') }
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GeoForge 本地运维台异常退出（exit $LASTEXITCODE）。" }
}

function Open-AgentConsole {
    Ensure-Supervisor
    Invoke-Supervisor start api
    $Arguments = @('run', 'agent', '--workspace', 'geo-agent-server', '--')
    if ($Check) { $Arguments += '--check' }
    if ($Json) { $Arguments += '--json' }
    if ($AgentPrompt) { $Arguments += @('--prompt', $AgentPrompt) }
    if ($AgentMode) { $Arguments += @('--mode', $AgentMode) }
    if ($AgentProvider) { $Arguments += @('--provider', $AgentProvider) }
    if ($AgentModel) { $Arguments += @('--model', $AgentModel) }
    if ($AgentThread) { $Arguments += @('--thread', $AgentThread) }
    if ($AgentTimeout) { $Arguments += @('--timeout', [string]$AgentTimeout) }
    if ($NoReasoning) { $Arguments += '--no-reasoning' }
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GeoForge 本机 Agent 异常退出（exit $LASTEXITCODE）。" }
}

if ($Action -in @('default', 'start', 'restart', 'console', 'agent')) { Invoke-GeoForgeBuild }

switch ($Action) {
    'default' {
        Ensure-Supervisor
        Invoke-Supervisor start all
        Open-LocalConsole
    }
    'start' {
        Ensure-Supervisor
        $Arguments = @('start', $Service)
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
    'stop' {
        if (-not (Test-Supervisor)) { Write-Host 'GeoForge 监督器未运行。' -ForegroundColor DarkGray; break }
        $Arguments = @('stop', $Service)
        if ($KeepPostgis) { $Arguments += '--keep-infra' }
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
    'restart' {
        Ensure-Supervisor
        $Arguments = @('restart', $Service)
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
    'status' {
        if (-not (Test-Supervisor)) { Write-Host 'GeoForge 监督器未运行。' -ForegroundColor Yellow; break }
        $Arguments = @('status')
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
    'logs' {
        if (-not (Test-Supervisor)) { throw 'GeoForge 监督器未运行。' }
        $Arguments = @('logs', $Service, '--tail', [string]$Tail)
        if ($FollowLogs) { $Arguments += '--follow' }
        Invoke-Supervisor @Arguments
    }
    'console' { Open-LocalConsole }
    'agent' { Open-AgentConsole }
    'shutdown' {
        if (-not (Test-Supervisor)) { Write-Host 'GeoForge 监督器未运行。' -ForegroundColor DarkGray; break }
        $Arguments = @('shutdown')
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
}

if ($OpenBrowser -and $Action -in @('default', 'start', 'restart')) {
    Start-Process "http://127.0.0.1:$($env:WEB_DEV_PORT)"
}
