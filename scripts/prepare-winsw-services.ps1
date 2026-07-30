# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - WinSW 服务包生成器
#
#   文件:       prepare-winsw-services.ps1
#
#   日期:       2026年07月21日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [string]$ServiceRoot = (Join-Path $env:ProgramData 'GeoForge\services'),
    [string]$SupervisorEnvironmentFile = (Join-Path $env:ProgramData 'GeoForge\supervisor.env')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'WinSW 服务包只能在 Windows 上生成。' }
$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$ServiceRoot = [IO.Path]::GetFullPath($ServiceRoot)
$PowerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$WinSW = (& (Join-Path $Root 'scripts\install-winsw.ps1') | Select-Object -Last 1)
if (-not $WinSW -or -not (Test-Path -LiteralPath $WinSW -PathType Leaf)) { throw 'WinSW 固定版本安装失败。' }

$Services = @(
    @{ Name = 'GeoForgeSupervisor'; Template = 'GeoForgeSupervisor.xml.template'; Environment = $SupervisorEnvironmentFile }
)

foreach ($Service in $Services) {
    $EnvironmentFile = [IO.Path]::GetFullPath([string]$Service.Environment)
    if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
        throw "缺少服务环境文件：$EnvironmentFile"
    }
    $TargetRoot = [IO.Path]::GetFullPath((Join-Path $ServiceRoot ([string]$Service.Name)))
    if (-not $TargetRoot.StartsWith($ServiceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'WinSW 服务包目标越出配置目录。'
    }
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
    $Executable = Join-Path $TargetRoot "$($Service.Name).exe"
    $Configuration = Join-Path $TargetRoot "$($Service.Name).xml"
    Copy-Item -LiteralPath $WinSW -Destination $Executable -Force
    $TemplatePath = Join-Path $Root "deploy\windows\$($Service.Template)"
    $Xml = Get-Content -LiteralPath $TemplatePath -Raw
    $Values = @{
        '@@GEOFORGE_ROOT@@' = $Root
        '@@PWSH_EXECUTABLE@@' = $PowerShell
        '@@SERVICE_ENV_FILE@@' = $EnvironmentFile
    }
    foreach ($Entry in $Values.GetEnumerator()) {
        $Escaped = [Security.SecurityElement]::Escape([string]$Entry.Value)
        $Xml = $Xml.Replace([string]$Entry.Key, $Escaped)
    }
    [xml]$Validated = $Xml
    $Validated.Save($Configuration)
    Write-Output $Executable
}
