# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Process Compose 固定版本安装器（Windows）
#
#   文件:       install-process-compose.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Manifest = Get-Content -LiteralPath (Join-Path $Root 'vendor\operations\checksums.json') -Raw | ConvertFrom-Json
$Version = [string]$Manifest.processCompose.version
$Architecture = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    'X64' { 'amd64' }
    'Arm64' { 'arm64' }
    default { throw 'Process Compose 仅支持当前安装器列出的 Windows amd64/arm64 架构。' }
}
$Expected = [string]$Manifest.processCompose."windows_$Architecture"
$ToolRoot = [IO.Path]::GetFullPath((Join-Path $Root "runtime\tools\process-compose\$Version"))
$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $Root 'runtime'))
if (-not $ToolRoot.StartsWith($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Process Compose 安装目标越出 runtime 目录。'
}
$ConfigRoot = [Environment]::GetEnvironmentVariable('PROC_COMP_CONFIG', 'Process')
if (-not $ConfigRoot) {
    $ConfigRoot = Join-Path $RuntimeRoot 'ops\process-compose-config'
    [Environment]::SetEnvironmentVariable('PROC_COMP_CONFIG', $ConfigRoot, 'Process')
}
New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
$Executable = Join-Path $ToolRoot 'process-compose.exe'
if (Test-Path -LiteralPath $Executable) {
    $InstalledVersion = (& $Executable version --short 2>$null).Trim().TrimStart('v')
    if ($InstalledVersion -eq $Version) { Write-Output $Executable; exit 0 }
    throw "已安装 Process Compose 版本不匹配：$InstalledVersion。"
}

New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
$Archive = Join-Path $ToolRoot "process-compose_windows_$Architecture.zip"
$Url = "https://github.com/F1bonacc1/process-compose/releases/download/v$Version/process-compose_windows_$Architecture.zip"
Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
$Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Archive -Force
    throw "Process Compose 发布包 SHA256 校验失败；期望 $Expected，实际 $Actual。"
}
Expand-Archive -LiteralPath $Archive -DestinationPath $ToolRoot -Force
Remove-Item -LiteralPath $Archive -Force
if (-not (Test-Path -LiteralPath $Executable)) { throw 'Process Compose 发布包中缺少 process-compose.exe。' }
$InstalledVersion = (& $Executable version --short).Trim().TrimStart('v')
if ($InstalledVersion -ne $Version) { throw "Process Compose 二进制版本不匹配：$InstalledVersion。" }
Write-Output $Executable
