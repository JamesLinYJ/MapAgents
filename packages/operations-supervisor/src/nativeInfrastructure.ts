// +-------------------------------------------------------------------------
//
//   地理智能平台 - 原生基础设施进程组
//
//   文件:       nativeInfrastructure.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import concurrently, { type Command, type ConcurrentlyResult } from 'concurrently'

import { resolveNativeInfrastructureConfig, type NativeInfrastructureConfig } from './nativeInfrastructureConfig.js'

const execFileAsync = promisify(execFile)
const currentFile = fileURLToPath(import.meta.url)

export async function runNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  await verifyPostgisInstallation(config)
  await ensurePostgresCluster(config)

  const postgres = startGroup([{
    name: 'postgresql',
    command: commandLine(config.database.binaries.postgres, [
      '-D', config.database.dataDirectory,
      '-h', config.database.host,
      '-p', String(config.database.port),
      '-c', 'log_checkpoints=off',
    ]),
  }], config)
  const stopPostgres = installShutdownHandlers(postgres.commands)

  try {
    await waitForPostgres(config, 60_000)
    await ensureDatabase(config)
    await applyMigrations(config)
    await failWhenGroupExits(postgres, 'PostgreSQL')
  } finally {
    stopPostgres()
    killCommands(postgres.commands)
  }
}

export async function checkNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  await execFileAsync(config.database.binaries.psql, postgisHealthArguments(config), {
    env: processEnvironment(config),
    timeout: 10_000,
    windowsHide: true,
  })
}

/**
 * PostgreSQL 由固定数据目录标识，并通过 pg_ctl 进行 fast shutdown。未初始化或
 * 已停止的私有集群视为幂等成功；不扫描进程表，也不接管任意 PostgreSQL 实例。
 */
export async function stopNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  const versionFile = path.join(config.database.dataDirectory, 'PG_VERSION')
  try {
    await fs.access(versionFile)
  } catch {
    return
  }

  try {
    await execFileAsync(config.database.binaries.pgCtl, [
      '-D', config.database.dataDirectory,
      'status',
    ], {
      cwd: config.projectRoot,
      env: processEnvironment(config),
      timeout: 10_000,
      windowsHide: true,
    })
  } catch {
    return
  }

  await execFileAsync(config.database.binaries.pgCtl, [
    '-D', config.database.dataDirectory,
    '-m', 'fast',
    '-w',
    '-t', '30',
    'stop',
  ], {
    cwd: config.projectRoot,
    env: processEnvironment(config),
    timeout: 40_000,
    windowsHide: true,
  })
}

/**
 * `pg_isready` 只能证明 PostgreSQL 正在接受连接；即使目标数据库尚未创建，
 * 它仍可能返回成功。Infra 必须在 PostGIS 与基线表均可查询后才对依赖方报健康。
 */
export function postgisHealthArguments(config: NativeInfrastructureConfig): string[] {
  return [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', [
      'SELECT postgis_full_version();',
      'SELECT 1 FROM platform_sessions LIMIT 0;',
      'SELECT 1 FROM platform_layer_features LIMIT 0;',
      'SELECT 1 FROM platform_schema_migrations LIMIT 0;',
    ].join(' '),
  ]
}

async function verifyPostgisInstallation(config: NativeInfrastructureConfig): Promise<void> {
  const { stdout } = await execFileAsync(config.database.binaries.pgConfig, ['--sharedir'], {
    timeout: 5_000,
    windowsHide: true,
  })
  const controlFile = path.join(stdout.trim(), 'extension', 'postgis.control')
  try {
    await fs.access(controlFile)
  } catch {
    throw new Error(
      `当前 PostgreSQL 未安装 PostGIS 扩展（缺少 ${controlFile}）。请先安装与 PostgreSQL 主版本匹配的官方 PostGIS。`,
    )
  }
}

async function ensurePostgresCluster(config: NativeInfrastructureConfig): Promise<void> {
  const versionFile = path.join(config.database.dataDirectory, 'PG_VERSION')
  try {
    await fs.access(versionFile)
    return
  } catch {
    await fs.mkdir(config.database.dataDirectory, { recursive: true })
  }

  const passwordFile = path.join(config.runtimeRoot, 'native', `.postgres-password-${process.pid}`)
  await fs.mkdir(path.dirname(passwordFile), { recursive: true })
  await fs.writeFile(passwordFile, `${config.database.password}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await execFileAsync(config.database.binaries.initdb, [
      '--pgdata', config.database.dataDirectory,
      '--username', config.database.user,
      '--pwfile', passwordFile,
      '--auth-host', 'scram-sha-256',
      '--auth-local', 'scram-sha-256',
      '--encoding', 'UTF8',
    ], {
      cwd: config.projectRoot,
      env: processEnvironment(config),
      timeout: 120_000,
      windowsHide: true,
    })
  } finally {
    await fs.rm(passwordFile, { force: true })
  }
}

async function ensureDatabase(config: NativeInfrastructureConfig): Promise<void> {
  const common = databaseArguments(config, 'postgres')
  const { stdout } = await execFileAsync(config.database.binaries.psql, [
    ...common,
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${config.database.name}'`,
  ], {
    env: processEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  if (stdout.trim() === '1') return
  await execFileAsync(config.database.binaries.createdb, [
    '-h', config.database.host,
    '-p', String(config.database.port),
    '-U', config.database.user,
    config.database.name,
  ], {
    env: processEnvironment(config),
    timeout: 30_000,
    windowsHide: true,
  })
}

async function applyMigrations(config: NativeInfrastructureConfig): Promise<void> {
  const migrationDirectory = path.join(config.projectRoot, 'infra', 'migrations')
  const entries = await loadMigrationEntries(migrationDirectory)
  if (!entries.length) throw new Error('未找到数据库 migration，原生基础设施拒绝启动。')

  const applied = await readAppliedMigrations(config)
  const knownIds = new Set(entries.map(entry => entry.id))
  const unknownApplied = [...applied.keys()].filter(id => !knownIds.has(id))
  if (unknownApplied.length > 0) {
    throw new Error(
      `数据库包含当前发布未提供的 migration：${unknownApplied.join('、')}。`
      + '请先安装匹配的服务制品，禁止继续启动。',
    )
  }

  const pending = []
  for (const entry of entries) {
    const previous = applied.get(entry.id)
    if (previous?.checksum && previous.checksum !== entry.checksum) {
      throw new Error(
        `migration ${entry.id} 的 checksum 已变化（数据库 ${previous.checksum}，文件 ${entry.checksum}）。`
        + '已应用 migration 不得修改，请恢复原文件并创建新的增量 migration。',
      )
    }
    if (!previous || !previous.checksum) pending.push(entry)
  }
  if (!pending.length) return

  const release = config.environment.RELEASE_VERSION
    ?? config.environment.APP_VERSION
    ?? 'development'
  const wrapperPath = path.join(
    config.runtimeRoot,
    'native',
    `.migration-run-${process.pid}-${Date.now()}.sql`,
  )
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true })
  await fs.writeFile(wrapperPath, buildMigrationWrapper(pending, release), {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await execFileAsync(config.database.binaries.psql, [
      ...databaseArguments(config, config.database.name),
      '-v', 'ON_ERROR_STOP=1',
      '-f', wrapperPath,
    ], {
      cwd: config.projectRoot,
      env: processEnvironment(config),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
  } finally {
    await fs.rm(wrapperPath, { force: true })
  }
}

interface MigrationEntry {
  id: string
  filePath: string
  checksum: string
}

interface AppliedMigration {
  checksum: string | null
}

async function loadMigrationEntries(migrationDirectory: string): Promise<MigrationEntry[]> {
  const entries = (await fs.readdir(migrationDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^\d{3}_[a-z0-9_]+\.sql$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const migrations: MigrationEntry[] = []
  for (const entry of entries) {
    const filePath = path.join(migrationDirectory, entry.name)
    const content = await fs.readFile(filePath)
    migrations.push({
      id: entry.name.replace(/\.sql$/u, ''),
      filePath,
      // Git/Windows may materialize SQL with CRLF; checksum the logical SQL
      // text so a checkout on another platform does not look like migration drift.
      checksum: createHash('sha256')
        .update(content.toString('utf8').replace(/\r\n?/gu, '\n'))
        .digest('hex'),
    })
  }
  return migrations
}

async function readAppliedMigrations(
  config: NativeInfrastructureConfig,
): Promise<Map<string, AppliedMigration>> {
  const tableResult = await execFileAsync(config.database.binaries.psql, [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT to_regclass('public.platform_schema_migrations');",
  ], {
    env: processEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  if (!tableResult.stdout.trim()) return new Map()

  const checksumColumnResult = await execFileAsync(config.database.binaries.psql, [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', [
      'SELECT 1 FROM information_schema.columns',
      "WHERE table_schema = 'public'",
      "AND table_name = 'platform_schema_migrations'",
      "AND column_name = 'checksum';",
    ].join(' '),
  ], {
    env: processEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  const query = checksumColumnResult.stdout.trim() === '1'
    ? 'SELECT migration_id, checksum FROM platform_schema_migrations ORDER BY migration_id;'
    : 'SELECT migration_id FROM platform_schema_migrations ORDER BY migration_id;'
  const result = await execFileAsync(config.database.binaries.psql, [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-F', '\t',
    '-v', 'ON_ERROR_STOP=1',
    '-c', query,
  ], {
    env: processEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  return parseAppliedMigrationRows(result.stdout)
}

function parseAppliedMigrationRows(output: string): Map<string, AppliedMigration> {
  const applied = new Map<string, AppliedMigration>()
  for (const line of output.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
    const [id, checksum] = line.split('\t')
    if (!id) continue
    applied.set(id, { checksum: checksum || null })
  }
  return applied
}

export function buildMigrationWrapper(entries: readonly MigrationEntry[], release: string): string {
  const lines = [
    '\\set ON_ERROR_STOP on',
    "SELECT pg_advisory_lock(hashtext('geo-agent-platform:migrations'));",
  ]
  for (const entry of entries) {
    lines.push(`\\i ${sqlLiteral(path.resolve(entry.filePath).replaceAll('\\', '/'))}`)
    lines.push(
      'INSERT INTO platform_schema_migrations '
      + '(migration_id, checksum, applied_at, application_release) '
      + `VALUES (${sqlLiteral(entry.id)}, ${sqlLiteral(entry.checksum)}, NOW(), ${sqlLiteral(release)}) `
      + 'ON CONFLICT (migration_id) DO UPDATE SET '
      + 'checksum = EXCLUDED.checksum, '
      + 'application_release = EXCLUDED.application_release;',
    )
  }
  lines.push('SELECT pg_advisory_unlock(hashtext(\'geo-agent-platform:migrations\'));')
  return `${lines.join('\n')}\n`
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function waitForPostgres(config: NativeInfrastructureConfig, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastReason = '尚未响应'
  while (Date.now() < deadline) {
    try {
      await execFileAsync(config.database.binaries.pgIsReady, [
        '-h', config.database.host,
        '-p', String(config.database.port),
        '-U', config.database.user,
        '-q',
      ], { timeout: 3_000, windowsHide: true })
      return
    } catch (error) {
      lastReason = safeReason(error)
      await delay(500)
    }
  }
  throw new Error(`PostgreSQL 未在 ${Math.ceil(timeoutMs / 1_000)} 秒内就绪：${lastReason}`)
}

function startGroup(
  commands: Array<{ name: string; command: string; env?: Record<string, string> }>,
  config: NativeInfrastructureConfig,
): ConcurrentlyResult {
  return concurrently(commands.map(command => ({
    ...command,
    cwd: config.projectRoot,
    env: {
      ...processEnvironment(config),
      ...command.env,
    },
  })), {
    prefix: '[{name}]',
    prefixColors: false,
    raw: false,
    handleInput: false,
    restartTries: 0,
    killOthersOn: ['failure', 'success'],
    killSignal: 'SIGTERM',
    killTimeout: 20_000,
    successCondition: 'all',
  })
}

function processEnvironment(config: NativeInfrastructureConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: config.database.password,
    PGHOST: config.database.host,
    PGPORT: String(config.database.port),
    PGUSER: config.database.user,
    PGDATABASE: config.database.name,
  }
}

function databaseArguments(config: NativeInfrastructureConfig, database: string): string[] {
  return [
    '-h', config.database.host,
    '-p', String(config.database.port),
    '-U', config.database.user,
    '-d', database,
  ]
}

function commandLine(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map(quoteShellArgument).join(' ')
}

function quoteShellArgument(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/gu, '""')}"`
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function installShutdownHandlers(commands: readonly Command[]): () => void {
  const stop = () => killCommands(commands)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function killCommands(commands: readonly Command[]): void {
  for (const command of commands) {
    if (!command.killed && !command.exited) command.kill('SIGTERM')
  }
}

async function failWhenGroupExits(result: ConcurrentlyResult, label: string): Promise<never> {
  try {
    const events = await result.result
    const exit = events[0]?.exitCode ?? 'unknown'
    throw new Error(`${label} 原生进程组意外退出（${String(exit)}）。`)
  } catch (error) {
    throw new Error(`${label} 原生进程组失败：${safeReason(error)}`)
  }
}

function safeReason(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '未知错误'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const projectRoot = process.env.GEO_AGENT_PLATFORM_ROOT ?? process.cwd()
  const runtimeRoot = process.env.RUNTIME_ROOT ?? path.join(projectRoot, 'runtime')
  const profile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const input = { projectRoot, runtimeRoot, profile, environment: process.env } as const
  if (process.argv.includes('--stop')) {
    await stopNativeInfrastructure(input)
    return
  }
  if (process.argv.includes('--check')) {
    await checkNativeInfrastructure(input)
    return
  }
  await runNativeInfrastructure(input)
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(currentFile)) {
  main().catch(error => {
    process.stderr.write(`原生基础设施启动失败：${safeReason(error)}\n`)
    process.exitCode = 1
  })
}
