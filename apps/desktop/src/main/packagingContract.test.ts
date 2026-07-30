// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 发布与安装契约测试
//
//   文件:       packagingContract.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const packageSchema = z.object({
  version: z.string(),
  productName: z.string().optional(),
  scripts: z.record(z.string(), z.string()),
})

describe('desktop packaging contract', () => {
  it('aligns the Desktop release version and builds internal workspaces from a cold checkout', async () => {
    const desktopPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as unknown)
    const rootPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), '..', '..', 'package.json'), 'utf8'),
    ) as unknown)

    expect(desktopPackage.version).toBe('0.1.0')
    expect(desktopPackage.version).toBe(rootPackage.version)
    expect(desktopPackage.productName).toBe('GeoForge')
    expect(desktopPackage.scripts.package).toContain('npm --prefix ../.. run build:desktop')
    expect(desktopPackage.scripts.package).toContain('require-node24.mjs')
    expect(desktopPackage.scripts.package).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts.make).toContain('npm --prefix ../.. run build:desktop')
    expect(desktopPackage.scripts.make).toContain('prepare-squirrel-vendor.ps1')
    expect(desktopPackage.scripts.make).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts['make:release']).toContain('make-desktop-release.ps1')

    const rootBuild = rootPackage.scripts['build:desktop']
    expect(rootBuild).toBeDefined()
    const workspaceOrder = [
      '@geo-agent-platform/shared-types',
      '@geo-agent-platform/conversation-presentation',
      '@geo-agent-platform/operations-supervisor',
      '@geo-agent-platform/desktop',
    ]
    let previousIndex = -1
    for (const workspace of workspaceOrder) {
      const currentIndex = rootBuild?.indexOf(workspace) ?? -1
      expect(currentIndex, workspace).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
    expect((await readFile(path.resolve(process.cwd(), '..', '..', '.node-version'), 'utf8')).trim())
      .toBe('24.14.0')
  })

  it('keeps Windows installer identity and metadata explicit in Forge', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')

    for (const requiredMetadata of [
      "appBundleId: 'com.geoforge.desktop'",
      "executableName: 'GeoForge'",
      "new URL('./assets/geoforge.ico', import.meta.url)",
      'icon: windowsIconPath',
      "CompanyName: 'GeoForge'",
      "OriginalFilename: 'GeoForge.exe'",
      "name: 'geoforge_desktop'",
      'setupExe: unsignedTestBuild',
      "'GeoForge-0.1.0-UNSIGNED-TEST-Setup.exe'",
      "'GeoForge-0.1.0-Setup.exe'",
      'asar: true',
      'vendorDirectory: squirrelVendorDirectory',
      'windowsSign: windowsSigningOptions',
      "'UNSIGNED-TEST-BUILD.txt'",
      "src: 'UNSIGNED-TEST-BUILD.txt'",
      'GEOFORGE_RELEASE_BUILD',
      'noMsi: true',
      'setupIcon: windowsIconPath',
      "name: '@electron-forge/maker-zip'",
      "platforms: ['win32']",
    ]) {
      expect(forgeSource, requiredMetadata).toContain(requiredMetadata)
    }
    expect(forgeSource).toContain("artifact.replace(/\\.zip$/iu, '-UNSIGNED-TEST.zip')")
    expect(forgeSource).not.toContain('fs.rmdir')
  })

  it('keeps unsigned verification builds distinct from signed production releases', async () => {
    const releaseScript = await readFile(
      path.resolve(process.cwd(), '..', '..', 'scripts', 'make-desktop-release.ps1'),
      'utf8',
    )

    for (const releaseBoundary of [
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      "SetEnvironmentVariable('GEOFORGE_RELEASE_BUILD', '1', 'Process')",
      'Get-AuthenticodeSignature -LiteralPath $File',
      'SignatureStatus]::Valid',
      'UNSIGNED-TEST-BUILD.txt',
    ]) {
      expect(releaseScript, releaseBoundary).toContain(releaseBoundary)
    }
  })

  it('ships a multi-resolution Windows icon for the app and Squirrel setup', async () => {
    const icon = await readFile(path.resolve(process.cwd(), 'assets', 'geoforge.ico'))
    expect(icon.readUInt16LE(0)).toBe(0)
    expect(icon.readUInt16LE(2)).toBe(1)
    const entryCount = icon.readUInt16LE(4)
    expect(entryCount).toBe(7)

    const dimensions = Array.from({ length: entryCount }, (_, index) => {
      const offset = 6 + index * 16
      const encodedWidth = icon.readUInt8(offset)
      const encodedHeight = icon.readUInt8(offset + 1)
      const width = encodedWidth === 0 ? 256 : encodedWidth
      const height = encodedHeight === 0 ? 256 : encodedHeight
      return `${width}x${height}`
    })
    expect(dimensions).toEqual([
      '16x16',
      '24x24',
      '32x32',
      '48x48',
      '64x64',
      '128x128',
      '256x256',
    ])
  })
})
