// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux RPM 本机运行时首次部署
//
//   文件:       packagedLocalRuntime.ts
//
//   日期:       2026年08月10日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_AUTH_CALLBACK_URL,
  PLATFORM_TECHNICAL_ID,
} from '@geo-agent-platform/shared-types/product-identity'

const execFileAsync = promisify(execFile)
const USER_SERVICE_NAME = 'geo-agent-platform-supervisor.service'
const RUNTIME_SERVICE_KIND = 'geo-agent-runtime-service'
const TOOL_PROVIDERS = [
  'geo-platform-chart',
  'geo-platform-geocode',
  'geo-platform-plan',
  'geo-platform-spatial',
  'geo-platform-meteorology',
  'geo-platform-public-weather',
  'geo-platform-memory',
  'geo-platform-media',
  'geo-platform-scheduled-wake-up',
].join(',')

export interface PackagedLocalRuntimeResolution {
  runtimeManifestPath: string
  manifestProtection: PackagedRuntimeManifestProtectionOptions
  serviceEnvironmentFile: string
}

export interface PackagedRuntimeManifestProtectionOptions {
  platform?: NodeJS.Platform
  expectedOwnerUid?: number
}

export interface PackagedLocalRuntimeOptions {
  platform: NodeJS.Platform
  resourcesPath: string
  homeDirectory?: string
  environment?: NodeJS.ProcessEnv
  ownerUid?: number
  systemRuntimeManifestPath: string
  isPortAvailable?: (port: number) => Promise<boolean>
  runSystemctl?: (arguments_: readonly string[]) => Promise<number>
}

export interface PackagedLocalRuntimeUserSettings {
  tiandituConfigured: boolean
}

export interface PackagedLocalRuntimeUserSettingsOptions {
  serviceEnvironmentFile: string
  ownerUid?: number
  tiandituApiKey?: string
  runSystemctl?: (arguments_: readonly string[]) => Promise<number>
}

/**
 * RPM 只安装不可变程序和系统依赖。首次启动在当前用户边界内生成密钥、私有
 * PostgreSQL 数据目录和 systemd user 配置；升级复用数据与密钥，仅切换制品路径。
 */
export async function preparePackagedLocalRuntime(
  options: PackagedLocalRuntimeOptions,
): Promise<PackagedLocalRuntimeResolution | null> {
  if (options.platform !== 'linux') return null
  if (await pathExists(options.systemRuntimeManifestPath)) return null

  const projectRoot = path.join(options.resourcesPath, 'runtime-service')
  const releaseManifestPath = path.join(projectRoot, 'runtime-service-manifest.json')
  if (!(await pathExists(releaseManifestPath))) return null
  await assertBundledRuntime(projectRoot)
  const releaseId = await readReleaseId(releaseManifestPath)

  const environment = options.environment ?? process.env
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
  const ownerUid = options.ownerUid ?? process.getuid?.()
  const configHome = resolveUserRoot(environment.XDG_CONFIG_HOME, path.join(homeDirectory, '.config'))
  const stateHome = resolveUserRoot(
    environment.XDG_STATE_HOME,
    path.join(homeDirectory, '.local', 'state'),
  )
  const configRoot = path.join(configHome, PLATFORM_TECHNICAL_ID)
  const runtimeRoot = path.join(stateHome, PLATFORM_TECHNICAL_ID, 'runtime')
  const secretsRoot = path.join(runtimeRoot, 'secrets')
  const environmentFile = path.join(configRoot, 'runtime.env')
  const runtimeManifestPath = path.join(configRoot, 'runtime-manifest.v1.json')
  const supervisorTokenFile = path.join(secretsRoot, 'supervisor.token')
  const rootSecretFile = path.join(secretsRoot, 'local-root.secret')

  await Promise.all([
    ensurePrivateDirectory(configRoot),
    ensurePrivateDirectory(runtimeRoot),
    ensurePrivateDirectory(secretsRoot),
    ensurePrivateDirectory(path.join(runtimeRoot, 'native')),
  ])
  await Promise.all([
    ensurePrivateSecret(supervisorTokenFile, ownerUid),
    ensurePrivateSecret(rootSecretFile, ownerUid),
  ])

  const previousEnvironment = await readOptionalProtectedEnvironment(environmentFile, ownerUid)
  const values = await buildRuntimeEnvironment({
    previousEnvironment,
    projectRoot,
    releaseId,
    runtimeRoot,
    supervisorTokenFile,
    rootSecretFile,
    isPortAvailable: options.isPortAvailable ?? defaultIsPortAvailable,
  })
  const environmentSource = serializeEnvironment(values)
  const environmentChanged = await writeProtectedFileIfChanged(
    environmentFile,
    environmentSource,
    ownerUid,
  )
  const manifestSource = `${JSON.stringify({
    kind: 'geo-agent-platform.desktop-runtime',
    schemaVersion: 1,
    projectRoot,
    runtimeRoot,
    apiBaseUrl: values.get('APP_BASE_URL'),
    supervisorTokenFile,
    allowedEnvironmentOverrides: [],
  }, null, 2)}\n`
  const manifestChanged = await writeProtectedFileIfChanged(
    runtimeManifestPath,
    manifestSource,
    ownerUid,
  )

  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl
  await requireSystemctl(runSystemctl, ['--user', 'daemon-reload'])
  await requireSystemctl(runSystemctl, ['--user', 'enable', USER_SERVICE_NAME])
  const active = await runSystemctl(['--user', 'is-active', '--quiet', USER_SERVICE_NAME]) === 0
  if (!active) {
    await requireSystemctl(runSystemctl, ['--user', 'start', USER_SERVICE_NAME])
  } else if (environmentChanged || manifestChanged) {
    await requireSystemctl(runSystemctl, ['--user', 'restart', USER_SERVICE_NAME])
  }

  return {
    runtimeManifestPath,
    manifestProtection: { platform: 'linux', ...(ownerUid === undefined ? {} : { expectedOwnerUid: ownerUid }) },
    serviceEnvironmentFile: environmentFile,
  }
}

/**
 * 读取可由桌面设置修改的本机运行时状态。凭据本身永不返回给 Renderer，
 * 只投影是否已经配置。
 */
export async function readPackagedLocalRuntimeUserSettings(
  options: Pick<PackagedLocalRuntimeUserSettingsOptions, 'serviceEnvironmentFile' | 'ownerUid'>,
): Promise<PackagedLocalRuntimeUserSettings> {
  const values = await readOptionalProtectedEnvironment(
    path.resolve(options.serviceEnvironmentFile),
    options.ownerUid,
  )
  return {
    tiandituConfigured: Boolean(values?.get('TIANDITU_API_KEY')?.trim()),
  }
}

/**
 * 原子更新 RPM 用户运行时的地图凭据，并只在值改变时重启后台服务。
 * runtime.env 始终保持 0600；调用者只传用户主动填写的新值。
 */
export async function updatePackagedLocalRuntimeUserSettings(
  options: PackagedLocalRuntimeUserSettingsOptions,
): Promise<PackagedLocalRuntimeUserSettings> {
  const environmentFile = path.resolve(options.serviceEnvironmentFile)
  const values = await readOptionalProtectedEnvironment(environmentFile, options.ownerUid)
  if (!values) throw new Error('本机运行时配置尚未初始化。')

  const apiKey = normalizeTiandituApiKey(options.tiandituApiKey)
  const changed = values.get('TIANDITU_API_KEY') !== apiKey
  if (changed) {
    values.set('TIANDITU_API_KEY', apiKey)
    await writeProtectedFileIfChanged(
      environmentFile,
      serializeEnvironment(values),
      options.ownerUid,
    )
    await requireSystemctl(
      options.runSystemctl ?? defaultRunSystemctl,
      ['--user', 'restart', USER_SERVICE_NAME],
    )
  }
  return { tiandituConfigured: true }
}

async function buildRuntimeEnvironment(input: {
  previousEnvironment: Map<string, string> | null
  projectRoot: string
  releaseId: string
  runtimeRoot: string
  supervisorTokenFile: string
  rootSecretFile: string
  isPortAvailable: (port: number) => Promise<boolean>
}): Promise<Map<string, string>> {
  const previous = input.previousEnvironment
  const ports = previous
    ? {
        api: parsePort(requiredValue(previous, 'API_PORT'), 'API_PORT'),
        worker: parsePort(requiredValue(previous, 'WORKER_PORT'), 'WORKER_PORT'),
        postgres: parsePort(requiredValue(previous, 'POSTGIS_PORT'), 'POSTGIS_PORT'),
      }
    : await chooseInitialPorts(input.isPortAvailable)
  const databaseUrl = previous?.get('DATABASE_URL')
    ?? `postgresql://geo_platform:${randomSecret()}@127.0.0.1:${ports.postgres}/geo_platform`
  assertLocalDatabaseUrl(databaseUrl, ports.postgres)

  const values = new Map(previous ?? [])
  const assignments: Record<string, string> = {
    NODE_ENV: 'production',
    GEO_AGENT_PLATFORM_ROOT: input.projectRoot,
    GEO_AGENT_PLATFORM_RELEASE_ID: input.releaseId,
    RUNTIME_ROOT: input.runtimeRoot,
    SEED_LAYERS_DIR: path.join(input.projectRoot, 'infra', 'seeds', 'layers'),
    GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: input.supervisorTokenFile,
    GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE: input.rootSecretFile,
    POSTGIS_PORT: String(ports.postgres),
    POSTGRES_DATA_DIR: path.join(input.runtimeRoot, 'native', 'postgresql'),
    WORKER_PORT: String(ports.worker),
    API_HOST: '127.0.0.1',
    API_PORT: String(ports.api),
    WORKER_PYTHON: '/usr/bin/python3',
    PYTHONPATH: [
      path.join(input.projectRoot, 'apps', 'worker', 'src'),
      path.join(input.projectRoot, 'packages', 'gis-meteorology', 'src'),
      path.join(input.projectRoot, 'python-packages'),
    ].join(path.delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    WORKER_MAX_CONCURRENCY: previous?.get('WORKER_MAX_CONCURRENCY') ?? '2',
    WORKER_NONCE_CACHE_MAX: previous?.get('WORKER_NONCE_CACHE_MAX') ?? '10000',
    WORKER_NONCE_STORE_PATH: path.join(input.runtimeRoot, '.worker-nonces.sqlite3'),
    WORKER_CONCURRENCY_STORE_PATH: path.join(input.runtimeRoot, '.worker-concurrency.sqlite3'),
    WORKER_CONCURRENCY_LEASE_SECONDS: '330',
    WORKER_TOOL_TIMEOUT_SECONDS: '300',
    DATABASE_URL: databaseUrl,
    WORKER_URL: `http://127.0.0.1:${ports.worker}`,
    APP_BASE_URL: `http://127.0.0.1:${ports.api}`,
    BETTER_AUTH_URL: `http://127.0.0.1:${ports.api}`,
    TRUSTED_ORIGINS: `${PLATFORM_DESKTOP_APP_ORIGIN},${PLATFORM_DESKTOP_AUTH_CALLBACK_URL}`,
    BETTER_AUTH_SECRET: previous?.get('BETTER_AUTH_SECRET') ?? randomSecret(),
    WORKER_SHARED_SECRET: previous?.get('WORKER_SHARED_SECRET') ?? randomSecret(),
    ENABLED_TOOL_PROVIDERS: previous?.get('ENABLED_TOOL_PROVIDERS') ?? TOOL_PROVIDERS,
    LOG_LEVEL: previous?.get('LOG_LEVEL') ?? 'info',
  }
  for (const [name, value] of Object.entries(assignments)) values.set(name, value)
  for (const secretName of ['BETTER_AUTH_SECRET', 'WORKER_SHARED_SECRET']) {
    if (requiredValue(values, secretName).length < 32) {
      throw new Error(`本机运行时配置中的 ${secretName} 无效。`)
    }
  }
  return values
}

async function chooseInitialPorts(
  isPortAvailable: (port: number) => Promise<boolean>,
): Promise<{ api: number; worker: number; postgres: number }> {
  const reserved = new Set<number>()
  const choose = async (preferred: number): Promise<number> => {
    for (let offset = 0; offset < 200; offset += 1) {
      const candidate = preferred + offset
      if (candidate > 65_535 || reserved.has(candidate)) continue
      if (await isPortAvailable(candidate)) {
        reserved.add(candidate)
        return candidate
      }
    }
    throw new Error(`无法为本机运行时找到从 ${preferred} 开始的可用端口。`)
  }
  return {
    api: await choose(8_000),
    worker: await choose(8_012),
    postgres: await choose(54_321),
  }
}

async function defaultIsPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => resolve(error === undefined))
    })
  })
}

async function defaultRunSystemctl(arguments_: readonly string[]): Promise<number> {
  try {
    // user service 的 TimeoutStopSec 是 120 秒；升级时 PostgreSQL/Worker 需要先
    // 完成一致性关闭。调用侧必须覆盖同一时限，不能在 systemd 仍正常收尾时
    // 提前把首次启动误报为失败。
    await execFileAsync('systemctl', [...arguments_], { timeout: 150_000, windowsHide: true })
    return 0
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') {
      return error.code
    }
    throw error
  }
}

async function requireSystemctl(
  run: (arguments_: readonly string[]) => Promise<number>,
  arguments_: readonly string[],
): Promise<void> {
  const status = await run(arguments_)
  if (status !== 0) {
    throw new Error(`无法启动本机后台服务（systemctl ${arguments_.join(' ')}，退出码 ${status}）。`)
  }
}

async function assertBundledRuntime(projectRoot: string): Promise<void> {
  for (const relativePath of [
    'apps/server/dist/main.js',
    'apps/operations-console/dist/installedCliEntry.js',
    'node-runtime/bin/node',
    'packages/operations-supervisor/dist/cli.js',
    'python-packages/cfgrib/__init__.py',
    'python-packages/docx/__init__.py',
    'infra/seeds/layers/catalog.json',
    'infra/seeds/layers/hangzhou_districts.geojson',
    'node_modules/.package-lock.json',
  ]) {
    const metadata = await stat(path.join(projectRoot, relativePath)).catch(() => null)
    if (!metadata?.isFile()) throw new Error(`RPM 内置运行时不完整：缺少 ${relativePath}。`)
  }
}

async function readReleaseId(manifestPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error('RPM 内置运行时 manifest 无效。')
  const values = parsed as Record<string, unknown>
  if (values.kind !== RUNTIME_SERVICE_KIND || values.schemaVersion !== 1) {
    throw new Error('RPM 内置运行时 manifest 类型或版本不受支持。')
  }
  if (typeof values.releaseId !== 'string' || !values.releaseId.trim()) {
    throw new Error('RPM 内置运行时 manifest 缺少 releaseId。')
  }
  return values.releaseId.trim()
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

async function ensurePrivateSecret(filePath: string, ownerUid: number | undefined): Promise<void> {
  try {
    const handle = await open(filePath, 'wx', 0o600)
    try {
      await handle.writeFile(`${randomSecret()}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error
  }
  await assertProtectedFile(filePath, ownerUid)
  const secret = (await readFile(filePath, 'utf8')).trim()
  if (secret.length < 32) throw new Error(`本机密钥文件内容无效：${filePath}`)
}

async function readOptionalProtectedEnvironment(
  filePath: string,
  ownerUid: number | undefined,
): Promise<Map<string, string> | null> {
  if (!(await pathExists(filePath))) return null
  await assertProtectedFile(filePath, ownerUid)
  return parseEnvironment(await readFile(filePath, 'utf8'))
}

async function writeProtectedFileIfChanged(
  filePath: string,
  source: string,
  ownerUid: number | undefined,
): Promise<boolean> {
  if (await pathExists(filePath)) {
    await assertProtectedFile(filePath, ownerUid)
    if (await readFile(filePath, 'utf8') === source) return false
  }
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}-${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
    const directoryHandle = await open(path.dirname(filePath), 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return true
}

async function assertProtectedFile(filePath: string, ownerUid: number | undefined): Promise<void> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`本机配置必须是单链接普通文件：${filePath}`)
  }
  if (ownerUid !== undefined && metadata.uid !== ownerUid) {
    throw new Error(`本机配置文件所有者不正确：${filePath}`)
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`本机配置文件权限过宽：${filePath}`)
  }
}

function parseEnvironment(source: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf('=')
    const name = line.slice(0, separator)
    const encoded = line.slice(separator + 1)
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || values.has(name)) {
      throw new Error(`本机运行时环境文件第 ${index + 1} 行无效。`)
    }
    let value: unknown
    try {
      value = JSON.parse(encoded)
    } catch {
      throw new Error(`本机运行时环境文件第 ${index + 1} 行不是受支持的值。`)
    }
    if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
      throw new Error(`本机运行时环境文件第 ${index + 1} 行包含无效值。`)
    }
    values.set(name, value)
  }
  return values
}

function serializeEnvironment(values: Map<string, string>): string {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join('\n') + '\n'
}

function resolveUserRoot(configured: string | undefined, fallback: string): string {
  const candidate = configured?.trim() || fallback
  if (!path.isAbsolute(candidate) || /[\r\n\0]/u.test(candidate)) {
    throw new Error('XDG 用户目录必须是有效绝对路径。')
  }
  return path.normalize(candidate)
}

function assertLocalDatabaseUrl(value: string, expectedPort: number): void {
  const url = new URL(value)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || Number(url.port || 5432) !== expectedPort
    || url.username !== 'geo_platform'
    || url.pathname !== '/geo_platform'
    || !url.password
  ) {
    throw new Error('已有本机 DATABASE_URL 与受管 PostgreSQL 配置不一致。')
  }
}

function parsePort(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`本机运行时配置中的 ${name} 无效。`)
  }
  return parsed
}

function requiredValue(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim()
  if (!value) throw new Error(`本机运行时配置缺少 ${name}。`)
  return value
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function normalizeTiandituApiKey(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(normalized)) {
    throw new Error('天地图 API KEY 格式无效。')
  }
  return normalized
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
