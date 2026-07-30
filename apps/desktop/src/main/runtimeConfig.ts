// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面运行时配置
//
//   文件:       runtimeConfig.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { app } from 'electron'
import path from 'node:path'
import { z } from 'zod'

import {
  applyControlledRuntimeEnvironment,
  DESKTOP_RUNTIME_MANIFEST_FILENAME,
  loadDesktopRuntimeManifest,
  type RuntimeManifestProtectionOptions,
  validateDesktopRuntimeFilesystemTargets,
} from './runtimeManifest.js'

const absolutePathSchema = z.string().trim().min(1).refine(path.isAbsolute, '路径必须是绝对路径。')
const httpBaseUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'API 地址只允许 HTTP 或 HTTPS。' })
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'API 地址不能包含凭据、查询参数或片段。' })
  }
})

export interface DesktopRuntimeConfig {
  projectRoot: string
  runtimeRoot: string
  supervisorTokenFile: string
  apiBaseUrl: string
  profile: 'development' | 'production'
  runtimeManifestPath: string | null
  autoAuth: DesktopAutoAuthConfig | null
}

export interface DesktopAutoAuthConfig {
  email: string
  displayName: string
  credentialFile: string
  allowAccountCreation: boolean
}

export interface DesktopRuntimeResolutionContext {
  profile?: DesktopRuntimeConfig['profile']
  applicationPath?: string
  platform?: NodeJS.Platform
  runtimeManifestPath?: string
  manifestProtection?: RuntimeManifestProtectionOptions
}

export function resolveDesktopRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  context: DesktopRuntimeResolutionContext = {},
): DesktopRuntimeConfig {
  const profile = context.profile ?? (app.isPackaged ? 'production' : 'development')
  const productionValues = profile === 'production'
    ? resolveProductionRuntimeValues(environment, context)
    : null
  const projectRoot = productionValues?.projectRoot
    ?? resolveDevelopmentProjectRoot(environment, context.applicationPath ?? app.getAppPath())
  const runtimeRoot = productionValues?.runtimeRoot ?? absolutePathSchema.parse(
    path.resolve(environment.RUNTIME_ROOT?.trim() || path.join(projectRoot, 'runtime')),
  )
  const apiBaseUrl = productionValues?.apiBaseUrl ?? httpBaseUrlSchema.parse(
    (environment.APP_BASE_URL?.trim() || `http://127.0.0.1:${parsePort(environment.API_PORT) ?? 8000}`)
      .replace(/\/+$/u, ''),
  )
  const autoAuth = resolveDesktopAutoAuthConfig({
    environment,
    profile,
    runtimeRoot,
    apiBaseUrl,
  })
  const supervisorTokenFile = productionValues?.supervisorTokenFile ?? absolutePathSchema.parse(
    path.resolve(
      environment.GEOFORGE_SUPERVISOR_TOKEN_FILE?.trim()
        || path.join(runtimeRoot, 'ops', 'supervisor.token'),
    ),
  )
  return {
    projectRoot,
    runtimeRoot,
    supervisorTokenFile,
    apiBaseUrl,
    profile,
    runtimeManifestPath: productionValues?.manifestPath ?? null,
    autoAuth,
  }
}

export function resolveDesktopAutoAuthConfig(input: {
  environment: NodeJS.ProcessEnv
  profile: DesktopRuntimeConfig['profile']
  runtimeRoot: string
  apiBaseUrl: string
}): DesktopAutoAuthConfig | null {
  const enabled = parseBoolean(
    input.environment.GEOFORGE_DESKTOP_AUTO_AUTH,
    'GEOFORGE_DESKTOP_AUTO_AUTH',
    input.profile === 'development',
  )
  if (!enabled) return null

  if (input.profile !== 'development') {
    throw new Error('桌面自动认证只允许在显式 development 环境启用。')
  }
  if (!isLoopbackUrl(input.apiBaseUrl)) {
    throw new Error('桌面自动认证只允许连接本机回环 API。')
  }

  const bootstrapEmail = z.string().email().max(320).parse(
    input.environment.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase(),
  )
  const email = z.string().email().max(320).parse(
    (input.environment.GEOFORGE_DESKTOP_AUTO_AUTH_EMAIL ?? bootstrapEmail).trim().toLowerCase(),
  )
  if (email !== bootstrapEmail) {
    throw new Error('自动认证账户必须与 BOOTSTRAP_ADMIN_EMAIL 一致，权限仍由服务端 RBAC 投影。')
  }

  const displayName = z.string().trim().min(1).max(160).parse(
    input.environment.GEOFORGE_DESKTOP_AUTO_AUTH_NAME ?? 'GeoForge 本机演示管理员',
  )
  const credentialFile = absolutePathSchema.parse(path.resolve(
    input.environment.GEOFORGE_DESKTOP_AUTO_AUTH_SECRET_FILE?.trim()
      || path.join(input.runtimeRoot, 'desktop', 'auto-auth.secret'),
  ))
  const allowAccountCreation = parseBoolean(
    input.environment.BETTER_AUTH_ALLOW_SIGN_UP,
    'BETTER_AUTH_ALLOW_SIGN_UP',
    true,
  )
  return { email, displayName, credentialFile, allowAccountCreation }
}

function resolveDevelopmentProjectRoot(
  environment: NodeJS.ProcessEnv,
  applicationPath: string,
): string {
  const configured = environment.GEOFORGE_ROOT?.trim()
  if (configured) return absolutePathSchema.parse(path.resolve(configured))
  return absolutePathSchema.parse(path.resolve(applicationPath, '..', '..'))
}

function resolveProductionRuntimeValues(
  environment: NodeJS.ProcessEnv,
  context: DesktopRuntimeResolutionContext,
): {
  projectRoot: string
  runtimeRoot: string
  supervisorTokenFile: string
  apiBaseUrl: string
  manifestPath: string
} {
  const platform = context.platform ?? process.platform
  const manifestPath = context.runtimeManifestPath
    ?? defaultDesktopRuntimeManifestPath(platform, environment)
  const manifest = loadDesktopRuntimeManifest(manifestPath, {
    platform,
    ...context.manifestProtection,
  })
  const values = applyControlledRuntimeEnvironment(manifest, environment)
  validateDesktopRuntimeFilesystemTargets(values, platform)
  return {
    ...values,
    manifestPath,
  }
}

export function defaultDesktopRuntimeManifestPath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const programData = environment.ProgramData?.trim()
    if (!programData || !path.win32.isAbsolute(programData)) {
      throw new Error('生产桌面环境缺少有效的 Windows ProgramData 系统目录。')
    }
    return path.win32.join(programData, 'GeoForge', DESKTOP_RUNTIME_MANIFEST_FILENAME)
  }
  if (platform === 'linux') {
    return path.posix.join('/etc/geoforge', DESKTOP_RUNTIME_MANIFEST_FILENAME)
  }
  if (platform === 'darwin') {
    return path.posix.join('/Library/Application Support/GeoForge', DESKTOP_RUNTIME_MANIFEST_FILENAME)
  }
  throw new Error(`GeoForge Desktop 不支持当前生产平台：${platform}`)
}

function parsePort(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || !value.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new Error(`${name} 必须是 true/false 或 1/0。`)
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
