// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge 桌面打包配置
//
//   文件:       forge.config.mjs
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: ZIP 构建改用项目内跨版本 Maker，解除 cross-zip 对 Node 24 的隐式绑定。
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加基于 Electron Forge 官方 Maker 的 Linux RPM 发布链路。
// --------------------------------------------------------------------------

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import {
  PLATFORM_DESKTOP_APPLICATION_ID,
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_MACHINE_ID,
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { existsSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopZipMaker } from './packaging/desktopZipMaker.mjs'
import { DesktopRpmMaker } from './packaging/desktopRpmMaker.mjs'

const squirrelVendorDirectory = fileURLToPath(new URL('./.squirrel-vendor', import.meta.url))
const windowsIconPath = fileURLToPath(new URL('./assets/desktop.ico', import.meta.url))
const linuxIconPath = fileURLToPath(new URL('./assets/desktop.png', import.meta.url))
const windowsSigningOptions = resolveWindowsSigningOptions(process.env)
const unsignedTestBuild = windowsSigningOptions === undefined
const executableFilename = `${PRODUCT_EXECUTABLE_BASENAME}.exe`
const setupFilename = `${PRODUCT_EXECUTABLE_BASENAME}-0.1.0-Setup.exe`

export default {
  outDir: 'release',
  packagerConfig: {
    appBundleId: PLATFORM_DESKTOP_APPLICATION_ID,
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: PRODUCT_EXECUTABLE_BASENAME,
    icon: windowsIconPath,
    windowsSign: windowsSigningOptions,
    win32metadata: {
      CompanyName: 'Geo Agent Platform Contributors',
      FileDescription: PRODUCT_DESKTOP_NAME,
      InternalName: PRODUCT_EXECUTABLE_BASENAME,
      OriginalFilename: executableFilename,
      ProductName: PRODUCT_CODENAME,
    },
    // electron-vite bundles Main, Preload and Renderer into /out. Packaging an
    // allowlisted build tree avoids npm-workspace symlink traversal and keeps
    // source, tests and development dependencies out of the installed app.
    ignore: filePath => !isPackagedApplicationFile(filePath),
    protocols: [
      {
        name: `${PRODUCT_CODENAME} Desktop Protocol`,
        schemes: [PLATFORM_DESKTOP_PROTOCOL_SCHEME],
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: `${PLATFORM_MACHINE_ID}_desktop`,
        authors: 'Geo Agent Platform Contributors',
        copyright: 'Copyright © Geo Agent Platform Contributors',
        description: PRODUCT_DESKTOP_NAME,
        exe: executableFilename,
        additionalFiles: unsignedTestBuild
          ? [{ src: 'UNSIGNED-TEST-BUILD.txt', target: 'lib\\net45' }]
          : [],
        noMsi: true,
        setupIcon: windowsIconPath,
        setupExe: unsignedTestBuild
          ? `${PRODUCT_EXECUTABLE_BASENAME}-0.1.0-UNSIGNED-TEST-Setup.exe`
          : setupFilename,
        title: PRODUCT_CODENAME,
        vendorDirectory: squirrelVendorDirectory,
        windowsSign: windowsSigningOptions,
      },
    },
    new DesktopZipMaker({}, ['win32']),
    new DesktopRpmMaker({
      options: {
        name: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        productDescription: '本机地理空间分析、气象数据处理与智能体工作台',
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
        license: 'UNLICENSED',
      },
    }, ['linux']),
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (!unsignedTestBuild || packageResult.platform !== 'win32') return
      await Promise.all(packageResult.outputPaths.map(outputPath => writeFile(
        path.join(outputPath, 'UNSIGNED-TEST-BUILD.txt'),
        [
          `${PRODUCT_CODENAME} UNSIGNED TEST BUILD`,
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
  const releaseBuild = environment.GEO_AGENT_PLATFORM_RELEASE_BUILD?.trim() === '1'
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
