// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面首次设置与部署选择
//
//   文件:       productSetup.ts
//
//   说明:       本机受管运行时优先；普通安装包在没有系统清单时改为连接
//               用户指定的服务端。用户配置只保存服务地址，不保存凭据。
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  API_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  runtimeCapabilitiesSchema,
} from '@geo-agent-platform/shared-types/release'

import type {
  DesktopProductSetupConnection,
  DesktopProductSetupStatus,
  DesktopProductSetupTestResult,
} from '../contracts/desktopIpc.js'
import { readBoundedResponseText } from './boundedResponseBody.js'
import {
  defaultDesktopRuntimeManifestPath,
  resolveDesktopRuntimeConfig,
  type DesktopRuntimeConfig,
} from './runtimeConfig.js'
import type { RuntimeManifestProtectionOptions } from './runtimeManifest.js'

const USER_SETUP_KIND = 'geo-agent-platform.desktop-setup' as const
const USER_SETUP_SCHEMA_VERSION = 1 as const
const SETUP_RESPONSE_MAX_BYTES = 64 * 1024
const SETUP_REQUEST_TIMEOUT_MS = 8_000

const desktopUserSetupConfigSchema = z.object({
  kind: z.literal(USER_SETUP_KIND),
  schemaVersion: z.literal(USER_SETUP_SCHEMA_VERSION),
  mode: z.literal('remote'),
  apiBaseUrl: z.string().url(),
}).strict()

type DesktopUserSetupConfig = z.infer<typeof desktopUserSetupConfigSchema>

export type DesktopProductSetupResolution =
  | {
      state: 'required'
      suggestedApiBaseUrl: string
    }
  | {
      state: 'configured'
      deploymentMode: 'local_managed'
      apiBaseUrl: string
      canReset: false
      runtime: DesktopRuntimeConfig
    }
  | {
      state: 'configured'
      deploymentMode: 'remote'
      apiBaseUrl: string
      canReset: true
      runtime: null
    }

export interface DesktopProductSetupOptions {
  profile: DesktopRuntimeConfig['profile']
  environment: NodeJS.ProcessEnv
  applicationPath: string
  platform: NodeJS.Platform
  userSetupPath: string
  runtimeManifestPath?: string
  manifestProtection?: RuntimeManifestProtectionOptions
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

export class DesktopProductSetupService {
  constructor(private readonly options: DesktopProductSetupOptions) {}

  async resolve(): Promise<DesktopProductSetupResolution> {
    if (this.options.profile === 'development') {
      const runtime = resolveDesktopRuntimeConfig(this.options.environment, {
        profile: 'development',
        applicationPath: this.options.applicationPath,
        platform: this.options.platform,
      })
      return localResolution(runtime)
    }

    const runtimeManifestPath = this.options.runtimeManifestPath
      ?? defaultDesktopRuntimeManifestPath(this.options.platform, this.options.environment)
    if (await pathExists(runtimeManifestPath)) {
      const runtime = resolveDesktopRuntimeConfig(this.options.environment, {
        profile: 'production',
        applicationPath: this.options.applicationPath,
        platform: this.options.platform,
        runtimeManifestPath,
        manifestProtection: this.options.manifestProtection,
      })
      return localResolution(runtime)
    }

    const configured = await this.readUserSetup()
    if (configured) {
      return {
        state: 'configured',
        deploymentMode: 'remote',
        apiBaseUrl: configured.apiBaseUrl,
        canReset: true,
        runtime: null,
      }
    }
    return {
      state: 'required',
      suggestedApiBaseUrl: 'http://127.0.0.1:8000',
    }
  }

  async status(): Promise<DesktopProductSetupStatus> {
    return publicStatus(await this.resolve())
  }

  async test(input: DesktopProductSetupConnection): Promise<DesktopProductSetupTestResult> {
    const apiBaseUrl = parseDesktopApiBaseUrl(input.apiBaseUrl)
    const startedAt = (this.options.now ?? Date.now)()
    try {
      const request = (pathname: '/health' | '/health/capabilities') => this.options.fetch(
        new URL(pathname, `${apiBaseUrl}/`).toString(),
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS),
        },
      )
      const [healthResponse, capabilitiesResponse] = await Promise.all([
        request('/health'),
        request('/health/capabilities'),
      ])
      if (!healthResponse.ok) {
        throw new Error(`服务健康检查返回 HTTP ${healthResponse.status}。`)
      }
      if (!capabilitiesResponse.ok) {
        throw new Error(`服务能力检查返回 HTTP ${capabilitiesResponse.status}。`)
      }
      await readBoundedResponseText(healthResponse, SETUP_RESPONSE_MAX_BYTES, '服务健康响应')
      const capabilities = runtimeCapabilitiesSchema.parse(JSON.parse(
        await readBoundedResponseText(
          capabilitiesResponse,
          SETUP_RESPONSE_MAX_BYTES,
          '服务能力响应',
        ),
      ))
      assertRuntimeCompatibility(capabilities)
      return {
        ok: true,
        apiBaseUrl,
        latencyMs: elapsedMilliseconds(startedAt, (this.options.now ?? Date.now)()),
        releaseId: capabilities.releaseId,
        databaseSchemaVersion: capabilities.databaseSchemaVersion,
        message: '连接成功，服务端与当前桌面版本兼容。',
      }
    } catch (error) {
      return {
        ok: false,
        apiBaseUrl,
        latencyMs: elapsedMilliseconds(startedAt, (this.options.now ?? Date.now)()),
        releaseId: null,
        databaseSchemaVersion: null,
        message: safeConnectionMessage(error),
      }
    }
  }

  async save(input: DesktopProductSetupConnection): Promise<DesktopProductSetupStatus> {
    const local = await this.resolve()
    if (local.state === 'configured' && local.deploymentMode === 'local_managed') {
      return publicStatus(local)
    }
    const result = await this.test(input)
    if (!result.ok) throw new Error(result.message)
    await this.writeUserSetup({
      kind: USER_SETUP_KIND,
      schemaVersion: USER_SETUP_SCHEMA_VERSION,
      mode: 'remote',
      apiBaseUrl: result.apiBaseUrl,
    })
    return publicStatus(await this.resolve())
  }

  async reset(): Promise<DesktopProductSetupStatus> {
    await rm(this.options.userSetupPath, { force: true })
    return publicStatus(await this.resolve())
  }

  private async readUserSetup(): Promise<DesktopUserSetupConfig | null> {
    try {
      const file = await stat(this.options.userSetupPath)
      if (!file.isFile() || file.size > 16 * 1024) {
        throw new Error('桌面设置文件不是有效的小型常规文件。')
      }
      const parsed = desktopUserSetupConfigSchema.parse(JSON.parse(
        await readFile(this.options.userSetupPath, 'utf8'),
      ))
      return {
        ...parsed,
        apiBaseUrl: parseDesktopApiBaseUrl(parsed.apiBaseUrl),
      }
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw new Error(`无法读取桌面设置：${safeConnectionMessage(error)}`)
    }
  }

  private async writeUserSetup(input: DesktopUserSetupConfig): Promise<void> {
    const config = desktopUserSetupConfigSchema.parse(input)
    const directory = path.dirname(this.options.userSetupPath)
    const temporaryPath = path.join(directory, `.product-setup-${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.options.userSetupPath)
      if (this.options.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

export function parseDesktopApiBaseUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('请输入完整的服务地址，例如 https://geo.example.com。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务地址只支持 HTTP 或 HTTPS。')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址不能包含账号、密码、查询参数或片段。')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('服务地址只能填写站点根地址，不能包含 API 路径。')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('非本机服务必须使用 HTTPS，避免登录信息在网络中明文传输。')
  }
  return url.origin
}

function localResolution(runtime: DesktopRuntimeConfig): DesktopProductSetupResolution {
  return {
    state: 'configured',
    deploymentMode: 'local_managed',
    apiBaseUrl: runtime.apiBaseUrl,
    canReset: false,
    runtime,
  }
}

function publicStatus(resolution: DesktopProductSetupResolution): DesktopProductSetupStatus {
  if (resolution.state === 'required') return resolution
  return {
    state: 'configured',
    deploymentMode: resolution.deploymentMode,
    apiBaseUrl: resolution.apiBaseUrl,
    canReset: resolution.canReset,
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

function assertRuntimeCompatibility(capabilities: {
  apiProtocolVersion: number
  minDesktopProtocol: number
  maxDesktopProtocol: number
}): void {
  if (capabilities.apiProtocolVersion !== API_PROTOCOL_VERSION) {
    throw new Error(
      `服务端 API 协议为 ${capabilities.apiProtocolVersion}，当前桌面需要 ${API_PROTOCOL_VERSION}。`,
    )
  }
  if (
    DESKTOP_PROTOCOL_VERSION < capabilities.minDesktopProtocol
    || DESKTOP_PROTOCOL_VERSION > capabilities.maxDesktopProtocol
  ) {
    throw new Error(
      `当前桌面协议为 ${DESKTOP_PROTOCOL_VERSION}，服务端要求 ${capabilities.minDesktopProtocol}–${capabilities.maxDesktopProtocol}。`,
    )
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt))
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function safeConnectionMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? '服务返回了不兼容的数据。'
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return '无法连接服务端，请检查地址和网络后重试。'
}
