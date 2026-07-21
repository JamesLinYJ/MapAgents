# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows 服务固定入口
#
#   文件:       run-geoforge-windows-service.ps1
#
#   日期:       2026年07月21日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ProcessCompose', 'OpsGateway', 'TerminalBroker')]
    [string]$Component,

    [Parameter(Mandatory = $true)]
    [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$EnvironmentFile = [IO.Path]::GetFullPath($EnvironmentFile)
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    throw "服务环境文件不存在：$EnvironmentFile"
}

$Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($Line in Get-Content -LiteralPath $EnvironmentFile) {
    $Text = $Line.Trim()
    if (-not $Text -or $Text.StartsWith('#')) { continue }
    if (-not $Text.Contains('=')) { throw '服务环境文件包含无效行。' }
    $Parts = $Text.Split('=', 2)
    $Name = $Parts[0].Trim()
    if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw '服务环境文件包含无效变量名。' }
    if (-not $Seen.Add($Name)) { throw "服务环境文件包含重复变量：$Name" }
    $Value = $Parts[1].Trim()
    if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
        $Value = $Value.Substring(1, $Value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

[Environment]::SetEnvironmentVariable('GEOFORGE_ROOT', $Root, 'Process')
Set-Location -LiteralPath $Root

if ($Component -eq 'ProcessCompose') {
    $Manifest = Get-Content -LiteralPath (Join-Path $Root 'vendor\operations\checksums.json') -Raw | ConvertFrom-Json
    $Executable = Join-Path $Root "runtime\tools\process-compose\$($Manifest.processCompose.version)\process-compose.exe"
    $TokenFile = [Environment]::GetEnvironmentVariable('PROCESS_COMPOSE_TOKEN_FILE', 'Process')
    if (-not $TokenFile) { throw 'Process Compose 服务环境缺少 PROCESS_COMPOSE_TOKEN_FILE。' }
    $TokenFile = [IO.Path]::GetFullPath($TokenFile, $Root)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Process Compose 固定版本二进制不存在。' }
    if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw 'Process Compose 令牌文件不存在。' }
    & $Executable --address 127.0.0.1 --port 8080 --token-file $TokenFile --ordered-shutdown `
        -f (Join-Path $Root 'config\process-compose.production.windows.yaml') up --disable-dotenv --tui=false
    exit $LASTEXITCODE
}

$NodeExecutable = [Environment]::GetEnvironmentVariable('NODE_EXECUTABLE', 'Process')
if (-not $NodeExecutable -or -not [IO.Path]::IsPathRooted($NodeExecutable) -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw '运维服务必须通过 NODE_EXECUTABLE 配置存在的 Node.js 绝对路径。'
}
$Entry = if ($Component -eq 'OpsGateway') {
    Join-Path $Root 'server\dist\operations\opsGatewayRuntime.js'
} else {
    Join-Path $Root 'server\dist\operations\terminalBrokerEntry.js'
}
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { throw '运维服务构建产物不存在。' }
& $NodeExecutable $Entry
exit $LASTEXITCODE
