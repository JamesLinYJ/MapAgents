# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows Desktop 签名发布构建
#
#   文件:       make-desktop-release.ps1
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'GeoForge Windows 签名发布只能在 Windows 构建主机上执行。' }

$Root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$CertificateFile = [Environment]::GetEnvironmentVariable('WINDOWS_CERTIFICATE_FILE', 'Process')
$CertificatePassword = [Environment]::GetEnvironmentVariable('WINDOWS_CERTIFICATE_PASSWORD', 'Process')
if (-not $CertificateFile -or -not [IO.Path]::IsPathFullyQualified($CertificateFile)) {
    throw 'WINDOWS_CERTIFICATE_FILE 必须是绝对 PFX 文件路径。'
}
$CertificateFile = [IO.Path]::GetFullPath($CertificateFile)
if (-not (Test-Path -LiteralPath $CertificateFile -PathType Leaf)) {
    throw 'WINDOWS_CERTIFICATE_FILE 指向的 PFX 文件不存在。'
}
if (-not $CertificatePassword) {
    throw 'WINDOWS_CERTIFICATE_PASSWORD 不能为空。'
}

$PreviousReleaseBuild = [Environment]::GetEnvironmentVariable('GEOFORGE_RELEASE_BUILD', 'Process')
try {
    [Environment]::SetEnvironmentVariable('GEOFORGE_RELEASE_BUILD', '1', 'Process')
    Push-Location -LiteralPath $Root
    try {
        & npm.cmd run make --workspace '@geo-agent-platform/desktop'
        if ($LASTEXITCODE -ne 0) { throw 'GeoForge Desktop 签名 make 失败。' }
    } finally {
        Pop-Location
    }
} finally {
    [Environment]::SetEnvironmentVariable('GEOFORGE_RELEASE_BUILD', $PreviousReleaseBuild, 'Process')
}

$DesktopReleaseRoot = Join-Path $Root 'apps\desktop\release'
$SetupPath = Join-Path $DesktopReleaseRoot 'make\squirrel.windows\x64\GeoForge-0.1.0-Setup.exe'
$ApplicationPath = Join-Path $DesktopReleaseRoot 'GeoForge-win32-x64\GeoForge.exe'
$ZipPath = Join-Path $DesktopReleaseRoot 'make\zip\win32\x64\GeoForge-win32-x64-0.1.0.zip'
$RequiredSignedFiles = @($SetupPath, $ApplicationPath)
foreach ($File in $RequiredSignedFiles) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        throw "签名发布缺少预期产物：$File"
    }
    $Signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode 签名验证失败：$File ($($Signature.Status))"
    }
}

$UnsignedMarker = Join-Path $DesktopReleaseRoot 'GeoForge-win32-x64\UNSIGNED-TEST-BUILD.txt'
if (Test-Path -LiteralPath $UnsignedMarker) {
    throw '签名发布目录仍包含 UNSIGNED TEST 标记。'
}
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "签名发布缺少预期 ZIP：$ZipPath"
}

$ZipInspectionRoot = Join-Path ([IO.Path]::GetTempPath()) "geoforge-release-$([Guid]::NewGuid().ToString('N'))"
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $ZipInspectionRoot)
    if (Test-Path -LiteralPath (Join-Path $ZipInspectionRoot 'UNSIGNED-TEST-BUILD.txt')) {
        throw '签名发布 ZIP 仍包含 UNSIGNED TEST 标记。'
    }
    $ZipApplication = Join-Path $ZipInspectionRoot 'GeoForge.exe'
    $ZipSignature = Get-AuthenticodeSignature -LiteralPath $ZipApplication
    if ($ZipSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "ZIP 内应用 Authenticode 签名验证失败：$($ZipSignature.Status)"
    }
} finally {
    if (Test-Path -LiteralPath $ZipInspectionRoot) {
        Remove-Item -LiteralPath $ZipInspectionRoot -Recurse -Force
    }
}

Write-Output "签名安装器：$SetupPath"
Write-Output "签名应用：$ApplicationPath"
Write-Output "签名应用 ZIP：$ZipPath"
