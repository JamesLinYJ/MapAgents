# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows Worker 进程入口
#
#   文件:       run-worker.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
#
#   维护记录 (2026-07-23):
#     作者: OpenAI Codex
#     说明: 移除开发期 Uvicorn reload 子监督器，统一由 GeoForge 监督进程生命周期。
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
Set-Location -LiteralPath $Root

$ConfiguredPython = [Environment]::GetEnvironmentVariable('WORKER_PYTHON', 'Process')
if (-not $ConfiguredPython) {
    throw 'Worker 启动失败：缺少 WORKER_PYTHON。'
}

$PythonCommand = if (Test-Path -LiteralPath $ConfiguredPython -PathType Leaf) {
    [IO.Path]::GetFullPath($ConfiguredPython, $Root)
} else {
    $Resolved = Get-Command $ConfiguredPython -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Resolved) {
        throw 'Worker 启动失败：WORKER_PYTHON 指向的解释器不存在。'
    }
    $Resolved.Source
}

$WorkerPort = 0
if (-not [int]::TryParse($env:WORKER_PORT, [ref]$WorkerPort) -or $WorkerPort -lt 1 -or $WorkerPort -gt 65535) {
    throw 'Worker 启动失败：WORKER_PORT 必须是 1 到 65535 之间的整数。'
}

$Arguments = @(
    '-m', 'uvicorn',
    'worker_app.sidecar:app',
    '--app-dir', 'apps/worker/src',
    '--host', '127.0.0.1',
    '--port', [string]$WorkerPort
)

if ($env:NODE_ENV -eq 'production') {
    $WorkerProcesses = 0
    if (-not [int]::TryParse($env:WORKER_PROCESSES, [ref]$WorkerProcesses) -or $WorkerProcesses -lt 1 -or $WorkerProcesses -gt 64) {
        throw 'Worker 启动失败：生产环境的 WORKER_PROCESSES 必须是 1 到 64 之间的整数。'
    }
    $Arguments += @('--workers', [string]$WorkerProcesses)
}

& $PythonCommand @Arguments
exit $LASTEXITCODE
