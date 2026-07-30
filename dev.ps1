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
#   维护记录 (2026-07-29):
#     作者: OpenAI Codex
#     说明: 桌面入口启动三个后台服务后运行 Electron；浏览器工作台不再受监督。
#
#   维护记录 (2026-07-29):
#     作者: OpenAI Codex
#     说明: 支持一键桌面启动器显式传入已验证的 Node 24 可执行文件。
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('default', 'start', 'stop', 'restart', 'status', 'logs', 'console', 'agent', 'desktop', 'shutdown')]
    [string]$Action = 'default',

    [Parameter(Position = 1)]
    [ValidateSet('all', 'infra', 'worker', 'api')]
    [string]$Service = 'all',

    [ValidateRange(0, 10000)]
    [int]$Tail = 80,

    [switch]$KeepPostgis,
    [switch]$FollowLogs,
    [ValidateSet('debug', 'info', 'warn', 'error', 'unknown')]
    [string]$LogLevel,
    [ValidateSet('stdout', 'stderr', 'supervisor')]
    [string]$LogStream,
    [ValidateLength(0, 200)]
    [string]$LogSearch,
    [switch]$IncludeSupervisor,
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
$ConfiguredNode = [Environment]::GetEnvironmentVariable('GEOFORGE_NODE_EXECUTABLE', 'Process')
if ($ConfiguredNode) {
    $Node = if ([IO.Path]::IsPathRooted($ConfiguredNode)) {
        [IO.Path]::GetFullPath($ConfiguredNode)
    } else {
        [IO.Path]::GetFullPath((Join-Path $Root $ConfiguredNode))
    }
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
        throw 'GEOFORGE_NODE_EXECUTABLE 指向的 Node 可执行文件不存在。'
    }
} else {
    $Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$NodeDirectory = Split-Path -Parent $Node
$env:Path = "$NodeDirectory$([IO.Path]::PathSeparator)$($env:Path)"
& $Node (Join-Path $Root 'scripts\require-node24.mjs')
if ($LASTEXITCODE -ne 0) { throw 'GeoForge 开发入口要求先切换到 Node 24 LTS。' }
. (Join-Path $Root 'scripts\dev-environment.ps1')
Initialize-GeoForgeDevEnvironment -ProjectRoot $Root

$SupervisorCli = Join-Path $Root 'packages\operations-supervisor\dist\cli.js'
$OpsRoot = Join-Path $env:RUNTIME_ROOT 'ops'
$LaunchOut = Join-Path $OpsRoot 'supervisor-launch.stdout.log'
$LaunchError = Join-Path $OpsRoot 'supervisor-launch.stderr.log'

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
    param([switch]$BackgroundOnly)
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
    if ($BackgroundOnly) { return }
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

function Open-Desktop {
    # Electron Renderer 与后台服务生命周期解耦。Supervisor 在旁路启动，
    # Renderer 立即挂载并通过非模态状态提示自动恢复连接。
    if (-not (Test-Supervisor)) { Start-Supervisor -BackgroundOnly }
    & npm run dev --workspace '@geo-agent-platform/desktop'
    if ($LASTEXITCODE -ne 0) { throw "GeoForge 桌面应用异常退出（exit $LASTEXITCODE）。" }
}

if ($Action -in @('default', 'start', 'restart', 'console', 'agent', 'desktop')) { Invoke-GeoForgeBuild }

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
        if ($LogLevel) { $Arguments += @('--level', $LogLevel) }
        if ($LogStream) { $Arguments += @('--stream', $LogStream) }
        if ($LogSearch) { $Arguments += @('--search', $LogSearch) }
        if ($IncludeSupervisor) { $Arguments += '--supervisor' }
        Invoke-Supervisor @Arguments
    }
    'console' { Open-LocalConsole }
    'agent' { Open-AgentConsole }
    'desktop' { Open-Desktop }
    'shutdown' {
        if (-not (Test-Supervisor)) { Write-Host 'GeoForge 监督器未运行。' -ForegroundColor DarkGray; break }
        $Arguments = @('shutdown')
        if ($Json) { $Arguments += '--json' }
        Invoke-Supervisor @Arguments
    }
}
