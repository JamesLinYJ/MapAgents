# +-------------------------------------------------------------------------
#
#   GeoForge 地理智能平台 - Windows Desktop 生产运行时清单安装器
#
#   文件:       install-desktop-runtime-manifest.ps1
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ServicePrincipal,

    [string]$RuntimeRoot = 'C:\ProgramData\GeoForge\runtime',

    [string]$ApiBaseUrl = 'http://127.0.0.1:8000',

    [string]$SupervisorTokenFile,

    [string]$ServiceEnvironmentFile = 'C:\ProgramData\GeoForge\supervisor.env',

    [string]$OperatorsPrincipal = 'GeoForge Operators',

    [switch]$PreserveExistingSupervisorToken,

    [ValidateSet(
        'GEOFORGE_ROOT',
        'RUNTIME_ROOT',
        'APP_BASE_URL',
        'GEOFORGE_SUPERVISOR_TOKEN_FILE'
    )]
    [string[]]$AllowedEnvironmentOverrides = @()
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Desktop runtime manifest Windows 安装器只能在 Windows 上运行。' }

$Principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '安装受保护的 Desktop runtime manifest 需要管理员权限。'
}

$GeoForgeConfigRoot = [IO.Path]::GetFullPath('C:\ProgramData\GeoForge')
$ManifestPath = Join-Path $GeoForgeConfigRoot 'runtime-manifest.v1.json'
$SystemIdentity = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$AdministratorsIdentity = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$OperatorsIdentity = [Security.Principal.NTAccount]::new($OperatorsPrincipal).Translate(
    [Security.Principal.SecurityIdentifier]
)
$ServiceIdentity = [Security.Principal.NTAccount]::new($ServicePrincipal).Translate(
    [Security.Principal.SecurityIdentifier]
)

function Assert-GeoForgeOrdinaryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,

        [Parameter(Mandatory = $true)]
        [ValidateSet('File', 'Directory')]
        [string]$ExpectedType
    )

    $Item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    $IsExpectedType = if ($ExpectedType -eq 'Directory') { $Item.PSIsContainer } else { -not $Item.PSIsContainer }
    if (-not $IsExpectedType) {
        throw "$LiteralPath 不是预期的$ExpectedType。"
    }
    if (
        ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $Item.LinkType
    ) {
        throw "$LiteralPath 不能是符号链接、junction、hard link 或其它 reparse point。"
    }
}

function Add-GeoForgeFileAccessRule {
    param(
        [Parameter(Mandatory = $true)]
        [Security.AccessControl.FileSecurity]$Acl,

        [Parameter(Mandatory = $true)]
        [Security.Principal.IdentityReference]$Identity,

        [Parameter(Mandatory = $true)]
        [Security.AccessControl.FileSystemRights]$Rights
    )

    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        $Rights,
        [Security.AccessControl.AccessControlType]::Allow
    ))
}

function Set-GeoForgeProtectedFileAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,

        [switch]$AllowOperators,

        [switch]$AllowService
    )

    $Acl = [Security.AccessControl.FileSecurity]::new()
    $Acl.SetOwner($AdministratorsIdentity)
    $Acl.SetAccessRuleProtection($true, $false)
    Add-GeoForgeFileAccessRule -Acl $Acl -Identity $SystemIdentity `
        -Rights ([Security.AccessControl.FileSystemRights]::FullControl)
    Add-GeoForgeFileAccessRule -Acl $Acl -Identity $AdministratorsIdentity `
        -Rights ([Security.AccessControl.FileSystemRights]::FullControl)
    if ($AllowOperators) {
        Add-GeoForgeFileAccessRule -Acl $Acl -Identity $OperatorsIdentity `
            -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    }
    if ($AllowService) {
        Add-GeoForgeFileAccessRule -Acl $Acl -Identity $ServiceIdentity `
            -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    }
    Set-Acl -LiteralPath $LiteralPath -AclObject $Acl
}

function Add-GeoForgeDirectoryAccessRule {
    param(
        [Parameter(Mandatory = $true)]
        [Security.AccessControl.DirectorySecurity]$Acl,

        [Parameter(Mandatory = $true)]
        [Security.Principal.IdentityReference]$Identity,

        [Parameter(Mandatory = $true)]
        [Security.AccessControl.FileSystemRights]$Rights
    )

    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $Identity,
        $Rights,
        $Inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
}

function Set-GeoForgeProtectedDirectoryAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,

        [Parameter(Mandatory = $true)]
        [Security.AccessControl.FileSystemRights]$ServiceRights,

        [switch]$AllowOperators
    )

    $Acl = [Security.AccessControl.DirectorySecurity]::new()
    $Acl.SetOwner($AdministratorsIdentity)
    $Acl.SetAccessRuleProtection($true, $false)
    Add-GeoForgeDirectoryAccessRule -Acl $Acl -Identity $SystemIdentity `
        -Rights ([Security.AccessControl.FileSystemRights]::FullControl)
    Add-GeoForgeDirectoryAccessRule -Acl $Acl -Identity $AdministratorsIdentity `
        -Rights ([Security.AccessControl.FileSystemRights]::FullControl)
    Add-GeoForgeDirectoryAccessRule -Acl $Acl -Identity $ServiceIdentity -Rights $ServiceRights
    if ($AllowOperators) {
        Add-GeoForgeDirectoryAccessRule -Acl $Acl -Identity $OperatorsIdentity `
            -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    }
    Set-Acl -LiteralPath $LiteralPath -AclObject $Acl
}

if (-not [IO.Path]::IsPathFullyQualified($ProjectRoot)) {
    throw 'ProjectRoot 必须是绝对路径。'
}
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if ([IO.Path]::GetPathRoot($ProjectRoot) -eq $ProjectRoot) {
    throw 'ProjectRoot 不能是卷根目录。'
}
Assert-GeoForgeOrdinaryPath -LiteralPath $ProjectRoot -ExpectedType Directory

if (-not [IO.Path]::IsPathFullyQualified($RuntimeRoot)) {
    throw 'RuntimeRoot 必须是绝对路径。'
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$RelativeRuntimePath = [IO.Path]::GetRelativePath($GeoForgeConfigRoot, $RuntimeRoot)
if (
    -not $RelativeRuntimePath -or
    [IO.Path]::IsPathFullyQualified($RelativeRuntimePath) -or
    $RelativeRuntimePath -eq '..' -or
    $RelativeRuntimePath.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
) {
    throw 'RuntimeRoot 必须位于固定的 C:\ProgramData\GeoForge 配置根目录内部。'
}

if (-not $SupervisorTokenFile) {
    $SupervisorTokenFile = Join-Path $RuntimeRoot 'secrets\supervisor.token'
}
if (-not [IO.Path]::IsPathFullyQualified($SupervisorTokenFile)) {
    throw 'SupervisorTokenFile 必须是绝对路径。'
}
$SupervisorTokenFile = [IO.Path]::GetFullPath($SupervisorTokenFile)
$RelativeTokenPath = [IO.Path]::GetRelativePath($RuntimeRoot, $SupervisorTokenFile)
if (
    -not $RelativeTokenPath -or
    [IO.Path]::IsPathFullyQualified($RelativeTokenPath) -or
    $RelativeTokenPath -eq '..' -or
    $RelativeTokenPath.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
) {
    throw 'SupervisorTokenFile 必须位于 RuntimeRoot 内部。'
}
$TokenDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $SupervisorTokenFile))
if ($TokenDirectory.Equals($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SupervisorTokenFile 必须位于 RuntimeRoot 下的独立受保护目录中。'
}

if (-not [IO.Path]::IsPathFullyQualified($ServiceEnvironmentFile)) {
    throw 'ServiceEnvironmentFile 必须是绝对路径。'
}
$ServiceEnvironmentFile = [IO.Path]::GetFullPath($ServiceEnvironmentFile)
$RelativeEnvironmentPath = [IO.Path]::GetRelativePath($GeoForgeConfigRoot, $ServiceEnvironmentFile)
if (
    -not $RelativeEnvironmentPath -or
    [IO.Path]::IsPathFullyQualified($RelativeEnvironmentPath) -or
    $RelativeEnvironmentPath -eq '..' -or
    $RelativeEnvironmentPath.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
) {
    throw 'ServiceEnvironmentFile 必须位于固定的 C:\ProgramData\GeoForge 配置根目录内部。'
}
Assert-GeoForgeOrdinaryPath -LiteralPath $ServiceEnvironmentFile -ExpectedType File

try {
    $ApiUri = [Uri]::new($ApiBaseUrl, [UriKind]::Absolute)
} catch {
    throw 'ApiBaseUrl 必须是绝对 HTTP/HTTPS URL。'
}
if (
    $ApiUri.Scheme -notin @('http', 'https') -or
    $ApiUri.UserInfo -or
    $ApiUri.Query -or
    $ApiUri.Fragment -or
    $ApiUri.AbsolutePath -ne '/'
) {
    throw 'ApiBaseUrl 必须是不含凭据、路径、查询参数或片段的 HTTP/HTTPS 源站地址。'
}
$ApiBaseUrl = $ApiUri.GetLeftPart([UriPartial]::Authority)

if (($AllowedEnvironmentOverrides | Select-Object -Unique).Count -ne $AllowedEnvironmentOverrides.Count) {
    throw 'AllowedEnvironmentOverrides 不能包含重复项。'
}

$EnvironmentValidator = Join-Path $PSScriptRoot 'validate-production-environment.mjs'
if (-not (Test-Path -LiteralPath $EnvironmentValidator -PathType Leaf)) {
    throw '缺少生产监督器环境校验器。'
}
$Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $Node $EnvironmentValidator `
    --file $ServiceEnvironmentFile `
    --project-root $ProjectRoot `
    --runtime-root $RuntimeRoot `
    --supervisor-token-file $SupervisorTokenFile `
    --api-base-url $ApiBaseUrl
if ($LASTEXITCODE -ne 0) {
    throw '生产监督器环境校验失败。'
}

if ($PSCmdlet.ShouldProcess($ManifestPath, '安装受保护的 GeoForge Desktop runtime manifest')) {
    New-Item -ItemType Directory -Path $GeoForgeConfigRoot -Force | Out-Null
    Assert-GeoForgeOrdinaryPath -LiteralPath $GeoForgeConfigRoot -ExpectedType Directory
    Set-GeoForgeProtectedDirectoryAcl -LiteralPath $GeoForgeConfigRoot `
        -ServiceRights ([Security.AccessControl.FileSystemRights]::ReadAndExecute) `
        -AllowOperators

    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    Assert-GeoForgeOrdinaryPath -LiteralPath $RuntimeRoot -ExpectedType Directory
    Set-GeoForgeProtectedDirectoryAcl -LiteralPath $RuntimeRoot `
        -ServiceRights ([Security.AccessControl.FileSystemRights]::Modify) `
        -AllowOperators

    New-Item -ItemType Directory -Path $TokenDirectory -Force | Out-Null
    Assert-GeoForgeOrdinaryPath -LiteralPath $TokenDirectory -ExpectedType Directory
    Set-GeoForgeProtectedDirectoryAcl -LiteralPath $TokenDirectory `
        -ServiceRights ([Security.AccessControl.FileSystemRights]::ReadAndExecute) `
        -AllowOperators

    Assert-GeoForgeOrdinaryPath -LiteralPath $ServiceEnvironmentFile -ExpectedType File
    Set-GeoForgeProtectedFileAcl -LiteralPath $ServiceEnvironmentFile -AllowService

    if ($PreserveExistingSupervisorToken -and (Test-Path -LiteralPath $SupervisorTokenFile)) {
        Assert-GeoForgeOrdinaryPath -LiteralPath $SupervisorTokenFile -ExpectedType File
        $ExistingToken = [IO.File]::ReadAllText($SupervisorTokenFile).Trim()
        if ($ExistingToken -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw '显式保留的 Supervisor token 必须是 256 位 base64url 值。'
        }
        Set-GeoForgeProtectedFileAcl -LiteralPath $SupervisorTokenFile -AllowOperators -AllowService
    } else {
        $TokenBytes = [byte[]]::new(32)
        [Security.Cryptography.RandomNumberGenerator]::Fill($TokenBytes)
        $Token = [Convert]::ToBase64String($TokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $TemporaryTokenPath = Join-Path $TokenDirectory ".supervisor-token.$([Guid]::NewGuid().ToString('N')).tmp"
        try {
            [IO.File]::WriteAllText(
                $TemporaryTokenPath,
                "$Token$([Environment]::NewLine)",
                [Text.UTF8Encoding]::new($false)
            )
            Set-GeoForgeProtectedFileAcl -LiteralPath $TemporaryTokenPath -AllowOperators -AllowService
            [IO.File]::Move($TemporaryTokenPath, $SupervisorTokenFile, $true)
            Set-GeoForgeProtectedFileAcl -LiteralPath $SupervisorTokenFile -AllowOperators -AllowService
        } finally {
            if (Test-Path -LiteralPath $TemporaryTokenPath -PathType Leaf) {
                Remove-Item -LiteralPath $TemporaryTokenPath -Force
            }
        }
    }

    $Manifest = [ordered]@{
        kind = 'geoforge.desktop-runtime'
        schemaVersion = 1
        projectRoot = $ProjectRoot
        runtimeRoot = $RuntimeRoot
        apiBaseUrl = $ApiBaseUrl
        supervisorTokenFile = $SupervisorTokenFile
        allowedEnvironmentOverrides = @($AllowedEnvironmentOverrides)
    }
    $ManifestJson = $Manifest | ConvertTo-Json -Depth 4
    $TemporaryManifestPath = Join-Path $GeoForgeConfigRoot ".runtime-manifest.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText(
            $TemporaryManifestPath,
            "$ManifestJson$([Environment]::NewLine)",
            [Text.UTF8Encoding]::new($false)
        )
        Set-GeoForgeProtectedFileAcl -LiteralPath $TemporaryManifestPath -AllowOperators -AllowService
        [IO.File]::Move($TemporaryManifestPath, $ManifestPath, $true)
        Set-GeoForgeProtectedFileAcl -LiteralPath $ManifestPath -AllowOperators -AllowService
    } finally {
        if (Test-Path -LiteralPath $TemporaryManifestPath -PathType Leaf) {
            Remove-Item -LiteralPath $TemporaryManifestPath -Force
        }
    }
}

Write-Output "Desktop runtime manifest：$ManifestPath"
Write-Output "Supervisor token：$SupervisorTokenFile"
Write-Output "Service environment：$ServiceEnvironmentFile"
