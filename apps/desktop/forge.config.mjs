// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge Windows 打包配置
//
//   文件:       forge.config.mjs
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { existsSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const squirrelVendorDirectory = fileURLToPath(new URL('./.squirrel-vendor', import.meta.url))
const windowsIconPath = fileURLToPath(new URL('./assets/geoforge.ico', import.meta.url))
const windowsSigningOptions = resolveWindowsSigningOptions(process.env)
const unsignedTestBuild = windowsSigningOptions === undefined

export default {
  outDir: 'release',
  packagerConfig: {
    appBundleId: 'com.geoforge.desktop',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: 'GeoForge',
    icon: windowsIconPath,
    windowsSign: windowsSigningOptions,
    win32metadata: {
      CompanyName: 'GeoForge',
      FileDescription: 'GeoForge 地理智能工作台',
      InternalName: 'GeoForge',
      OriginalFilename: 'GeoForge.exe',
      ProductName: 'GeoForge',
    },
    // electron-vite bundles Main, Preload and Renderer into /out. Packaging an
    // allowlisted build tree avoids npm-workspace symlink traversal and keeps
    // source, tests and development dependencies out of the installed app.
    ignore: filePath => !isPackagedApplicationFile(filePath),
    protocols: [
      {
        name: 'GeoForge Desktop Protocol',
        schemes: ['geoforge'],
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'geoforge_desktop',
        authors: 'GeoForge',
        copyright: 'Copyright © GeoForge',
        description: 'GeoForge 地理智能工作台',
        exe: 'GeoForge.exe',
        additionalFiles: unsignedTestBuild
          ? [{ src: 'UNSIGNED-TEST-BUILD.txt', target: 'lib\\net45' }]
          : [],
        noMsi: true,
        setupIcon: windowsIconPath,
        setupExe: unsignedTestBuild
          ? 'GeoForge-0.1.0-UNSIGNED-TEST-Setup.exe'
          : 'GeoForge-0.1.0-Setup.exe',
        title: 'GeoForge',
        vendorDirectory: squirrelVendorDirectory,
        windowsSign: windowsSigningOptions,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
      config: {},
    },
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (!unsignedTestBuild) return
      await Promise.all(packageResult.outputPaths.map(outputPath => writeFile(
        path.join(outputPath, 'UNSIGNED-TEST-BUILD.txt'),
        [
          'GeoForge UNSIGNED TEST BUILD',
          'This package is for local verification only and must not be distributed as a production release.',
          '',
        ].join('\r\n'),
        'utf8',
      )))
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (!unsignedTestBuild) return makeResults
      return Promise.all(makeResults.map(async result => ({
        ...result,
        artifacts: await Promise.all(result.artifacts.map(async artifact => {
          if (!artifact.toLowerCase().endsWith('.zip')) return artifact
          const unsignedArtifact = artifact.replace(/\.zip$/iu, '-UNSIGNED-TEST.zip')
          await rename(artifact, unsignedArtifact)
          return unsignedArtifact
        })),
      })))
    },
  },
  plugins: [
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
}

function isPackagedApplicationFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return normalized === ''
    || normalized === '/'
    || normalized === '/package.json'
    || normalized === '/out'
    || normalized.startsWith('/out/')
}

function resolveWindowsSigningOptions(environment) {
  const releaseBuild = environment.GEOFORGE_RELEASE_BUILD?.trim() === '1'
  const certificateFile = environment.WINDOWS_CERTIFICATE_FILE?.trim()
  const certificatePassword = environment.WINDOWS_CERTIFICATE_PASSWORD
  if (!certificateFile && !certificatePassword) {
    if (releaseBuild) {
      throw new Error(
        '生产发布必须设置 WINDOWS_CERTIFICATE_FILE 和 WINDOWS_CERTIFICATE_PASSWORD；'
        + '无证书时只能生成带 UNSIGNED TEST 标记的本机测试构建。',
      )
    }
    return undefined
  }
  if (!certificateFile || !certificatePassword) {
    throw new Error('Windows 签名证书文件与密码必须同时设置。')
  }
  if (!path.win32.isAbsolute(certificateFile) || !existsSync(certificateFile)) {
    throw new Error('WINDOWS_CERTIFICATE_FILE 必须指向存在的绝对 PFX 文件。')
  }

  const timestampServer = environment.WINDOWS_TIMESTAMP_SERVER?.trim()
    || 'https://timestamp.digicert.com'
  const timestampUrl = new URL(timestampServer)
  if (
    timestampUrl.protocol !== 'https:'
    || timestampUrl.username
    || timestampUrl.password
    || timestampUrl.search
    || timestampUrl.hash
  ) {
    throw new Error('WINDOWS_TIMESTAMP_SERVER 必须是无凭据、查询参数或片段的 HTTPS URL。')
  }
  return {
    automaticallySelectCertificate: true,
    certificateFile,
    certificatePassword,
    hashes: ['sha256'],
    timestampServer: timestampUrl.toString(),
  }
}
