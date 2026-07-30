// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 发布与安装契约测试
//
//   文件:       packagingContract.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const packageSchema = z.object({
  version: z.string(),
  productName: z.string().optional(),
  engines: z.object({
    node: z.string(),
  }),
  scripts: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()).optional(),
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
    expect(desktopPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(rootPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(desktopPackage.scripts.package).toContain('npm --prefix ../.. run build:desktop')
    expect(desktopPackage.scripts.package).not.toContain('require-node24.mjs')
    expect(desktopPackage.scripts.package).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts.make).toContain('npm --prefix ../.. run build:desktop')
    expect(desktopPackage.scripts.make).toContain('prepare-squirrel-vendor.ps1')
    expect(desktopPackage.scripts.make).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts['make:release']).toContain('make-desktop-release.ps1')
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-base']).toBe('7.11.2')
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-zip']).toBeUndefined()

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
    const zipMakerSource = await readFile(
      path.resolve(process.cwd(), 'packaging', 'geoForgeZipMaker.mjs'),
      'utf8',
    )

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
      "import { GeoForgeZipMaker } from './packaging/geoForgeZipMaker.mjs'",
      "new GeoForgeZipMaker({}, ['win32'])",
    ]) {
      expect(forgeSource, requiredMetadata).toContain(requiredMetadata)
    }
    expect(forgeSource).toContain("artifact.replace(/\\.zip$/iu, '-UNSIGNED-TEST.zip')")
    expect(forgeSource).not.toContain('@electron-forge/maker-zip')
    expect(zipMakerSource).toContain('new ZipArchive(')
    expect(zipMakerSource).toContain('await rm(destinationPath, { force: true })')
    expect(zipMakerSource).not.toContain('fs.rmdir')
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

  it('creates the Windows ZIP artifact without the cross-zip compatibility path', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geoforge-zip-maker-'))
    try {
      const sourceDirectory = path.join(temporaryRoot, 'GeoForge-win32-x64')
      await mkdir(path.join(sourceDirectory, 'resources'), { recursive: true })
      await writeFile(path.join(sourceDirectory, 'GeoForge.exe'), 'desktop-fixture', 'utf8')
      await writeFile(path.join(sourceDirectory, 'resources', 'app.asar'), 'asar-fixture', 'utf8')

      const makerModuleUrl = pathToFileURL(
        path.resolve(process.cwd(), 'packaging', 'geoForgeZipMaker.mjs'),
      ).href
      const makerModule = await import(makerModuleUrl) as {
        GeoForgeZipMaker: new () => {
          platforms: string[]
          make: (options: {
            dir: string
            makeDir: string
            packageJSON: { version: string }
            targetArch: string
            targetPlatform: string
          }) => Promise<string[]>
        }
      }
      const maker = new makerModule.GeoForgeZipMaker()
      const artifacts = await maker.make({
        dir: sourceDirectory,
        makeDir: path.join(temporaryRoot, 'make'),
        packageJSON: { version: '0.1.0' },
        targetArch: 'x64',
        targetPlatform: 'win32',
      })

      expect(maker.platforms).toEqual(['win32'])
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]
      if (!artifact) throw new Error('ZIP Maker 未返回构建产物。')
      expect(artifact).toBe(path.join(
        temporaryRoot,
        'make',
        'zip',
        'win32',
        'x64',
        'GeoForge-win32-x64-0.1.0.zip',
      ))
      const archive = await readFile(artifact)
      expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304')
      expect(archive.length).toBeGreaterThan(100)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
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
