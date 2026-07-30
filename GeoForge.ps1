# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 一键桌面启动器
#
#   文件:       GeoForge.ps1
#
#   日期:       2026年07月29日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$Root = [IO.Path]::GetFullPath($PSScriptRoot)

function Test-GeoForgeNode24 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $false }
    try {
        $Version = (& $LiteralPath --version 2>$null).Trim()
        return $Version -match '^v24\.'
    } catch {
        return $false
    }
}

function Resolve-GeoForgeNode24 {
    $Candidates = [Collections.Generic.List[string]]::new()
    $Configured = [Environment]::GetEnvironmentVariable('GEOFORGE_NODE24', 'Process')
    if ($Configured) {
        $ConfiguredPath = if ([IO.Path]::IsPathRooted($Configured)) {
            [IO.Path]::GetFullPath($Configured)
        } else {
            [IO.Path]::GetFullPath((Join-Path $Root $Configured))
        }
        $Candidates.Add($ConfiguredPath)
    }

    foreach ($Command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $Candidates.Add($Command.Source)
    }

    $KnownLocations = @(
        (Join-Path $HOME '.volta\tools\image\node\24.14.0\node.exe'),
        (Join-Path $env:APPDATA 'nvm\v24.14.0\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'fnm\node-versions\v24.14.0\installation\node.exe'),
        (Join-Path $HOME '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    )
    foreach ($Location in $KnownLocations) {
        if ($Location) { $Candidates.Add($Location) }
    }

    foreach ($Candidate in @($Candidates | Select-Object -Unique)) {
        if (Test-GeoForgeNode24 -LiteralPath $Candidate) {
            return [IO.Path]::GetFullPath($Candidate)
        }
    }

    throw @'
未找到 Node.js 24 LTS。请安装 .node-version 指定的版本，或将
GEOFORGE_NODE24 设置为 node.exe 的绝对路径后重新运行 GeoForge.ps1。
'@
}

$Node = Resolve-GeoForgeNode24
$NodeDirectory = Split-Path -Parent $Node
$env:Path = "$NodeDirectory$([IO.Path]::PathSeparator)$($env:Path)"
$env:GEOFORGE_NODE_EXECUTABLE = $Node

& (Join-Path $Root 'dev.ps1') desktop
if ($LASTEXITCODE -ne 0) {
    throw "GeoForge 桌面应用异常退出（exit $LASTEXITCODE）。"
}
