// +-------------------------------------------------------------------------
//
//   地理智能平台 - Supervisor 结构化轮转日志
//
//   文件:       systemLogger.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

import type {
  OperationsLogPage,
  OperationsLogQuery,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import pino, { type Logger } from 'pino'
import { createStream, type RotatingFileStream } from 'rotating-file-stream'

import type { OperationsPaths } from './paths.js'
import { OperationsLogBuffer } from './logBuffer.js'

const ACTIVE_FILE_BYTES = 8 * 1024 * 1024
const TOTAL_LOG_BYTES = 224 * 1024 * 1024
const ROTATED_LOG_BYTES = TOTAL_LOG_BYTES - ACTIVE_FILE_BYTES
const RETENTION_MS = 14 * 24 * 60 * 60_000

export interface SupervisorLogger {
  logger: Logger
  persistenceState(): OperationsSnapshot['observability']['persistence']
  readHistory(query: OperationsLogQuery): Promise<OperationsLogPage>
  close(): Promise<void>
}

/**
 * 运行日志按大小和 UTC 日界轮转。诊断事件不会调用这个 transport，因此
 * 开启详细诊断只扩大内存飞行记录器，不会增加硬盘写入。
 */
export function createSupervisorLogger(
  paths: OperationsPaths,
  level = process.env.LOG_LEVEL ?? 'info',
  options: { includeStdout?: boolean; secrets?: readonly string[] } = {},
): SupervisorLogger {
  const activeName = path.basename(paths.systemLogFile)
  const prefix = activeName.replace(/\.jsonl$/u, '')
  const rotationName = createActualUtcRotationNameGenerator(activeName, prefix, '.jsonl')
  let persistence: OperationsSnapshot['observability']['persistence'] = {
    state: 'healthy',
    message: '日志持久化已初始化。',
    lastSuccessAt: null,
    lastErrorAt: null,
  }
  const markHealthy = (message: string): void => {
    persistence = {
      state: 'healthy',
      message,
      lastSuccessAt: new Date().toISOString(),
      lastErrorAt: persistence.lastErrorAt,
    }
  }
  const markFailure = (error: Error, retrying: boolean): void => {
    persistence = {
      state: retrying ? 'retrying' : 'degraded',
      message: `日志持久化异常：${safeMessage(error)}`,
      lastSuccessAt: persistence.lastSuccessAt,
      lastErrorAt: new Date().toISOString(),
    }
  }

  const stream = new RetryingRotatingFileSink(
    () => {
      const rotating = createStream(rotationName, {
        path: paths.operationsRoot,
        size: '8M',
        interval: '1d',
        intervalBoundary: true,
        intervalUTC: true,
        initialRotation: true,
        history: `${prefix}.history`,
        maxFiles: 64,
        maxSize: `${Math.floor(ROTATED_LOG_BYTES / (1024 * 1024))}M`,
        compress: false,
      })
      rotating.on('rotated', () => {
        markHealthy('日志轮转完成。')
        void pruneKnownLogFiles(paths.operationsRoot, prefix, paths.systemLogFile).catch(error => {
          markFailure(toError(error), true)
        })
      })
      return rotating
    },
    message => markHealthy(message),
    (error, retrying) => markFailure(error, retrying),
  )

  void pruneKnownLogFiles(paths.operationsRoot, prefix, paths.systemLogFile).catch(error => {
    markFailure(toError(error), true)
  })

  const destinations: Array<{ level: string; stream: NodeJS.WritableStream }> = [
    { level: persistentLogLevel(level), stream },
  ]
  if (options.includeStdout !== false) destinations.unshift({ level, stream: process.stdout })
  const logger = pino({
    level,
    base: {
      component: 'supervisor',
      supervisorPid: process.pid,
      workspaceId: paths.workspaceId,
    },
    redact: {
      paths: [
        '*.authorization',
        '*.cookie',
        '*.password',
        '*.secret',
        '*.token',
        'authorization',
        'cookie',
        'password',
        'secret',
        'token',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      log: value => sanitizePersistentRecord(value, options.secrets ?? []),
    },
  }, pino.multistream(destinations))

  return {
    logger,
    persistenceState: () => ({ ...persistence }),
    readHistory: query => readHistoricalLogPage(paths, prefix, query),
    close: async () => {
      stream.end()
      await finished(stream)
    },
  }
}

/**
 * 文件流失败后按指数退避重建。失败期间不在这里复制日志；Supervisor 的
 * OperationsLogBuffer 已是有界内存事实源，避免第二个隐形队列突破预算。
 */
export class RetryingRotatingFileSink extends Writable {
  private active: RotatingFileStream | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelayMs = 1_000
  private consecutiveFailures = 0
  private closing = false

  constructor(
    private readonly create: () => RotatingFileStream,
    private readonly onHealthy: (message: string) => void,
    private readonly onFailure: (error: Error, retrying: boolean) => void,
  ) {
    super()
    this.open()
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const stream = this.active
    if (!stream) {
      callback()
      return
    }
    stream.write(chunk, encoding, error => {
      if (error) this.handleFailure(stream, error)
      else if (stream === this.active) this.onHealthy('日志文件可写。')
      callback()
    })
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closing = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const stream = this.active
    this.active = null
    if (!stream) {
      callback()
      return
    }
    stream.end(callback)
  }

  private open(): void {
    if (this.closing) return
    try {
      const stream = this.create()
      this.active = stream
      stream.once('open', () => {
        if (stream !== this.active) return
        this.consecutiveFailures = 0
        this.retryDelayMs = 1_000
        this.onHealthy('日志文件可写。')
      })
      stream.on('warning', error => this.onFailure(error, true))
      stream.on('error', error => this.handleFailure(stream, error))
    } catch (error) {
      this.handleOpenFailure(toError(error))
    }
  }

  private handleFailure(stream: RotatingFileStream, error: Error): void {
    if (stream !== this.active) return
    this.active = null
    stream.destroy()
    this.handleOpenFailure(error)
  }

  private handleOpenFailure(error: Error): void {
    this.consecutiveFailures += 1
    this.onFailure(error, this.consecutiveFailures < 5)
    if (this.closing || this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
    this.retryTimer.unref()
  }
}

export function rotatedLogFileName(prefix: string, time: number | Date, index: number): string {
  const timestamp = (time instanceof Date ? time : new Date(time))
    .toISOString()
    .replace(/[:.]/gu, '-')
  return `${prefix}.${timestamp}.${index}.jsonl`
}

/**
 * 组件的 UTC 边界时间用于决定何时轮转；文件名使用轮转真正发生时的 UTC
 * 时间。相同边界和索引重复求名时保持稳定，避免一次轮转产生多个候选名称。
 */
export function createActualUtcRotationNameGenerator(
  activeName: string,
  prefix: string,
  extension: '.jsonl' | '.log',
  now: () => Date = () => new Date(),
): (time: number | Date, index?: number) => string {
  const actualTimes = new Map<string, Date>()
  return (time, index = 0) => {
    if (!time) return activeName
    const boundary = time instanceof Date ? time.getTime() : time
    const key = `${boundary}:${index}`
    let actual = actualTimes.get(key)
    if (!actual) {
      actual = now()
      actualTimes.set(key, actual)
      if (actualTimes.size > 128) {
        const oldest = actualTimes.keys().next().value
        if (oldest !== undefined) actualTimes.delete(oldest)
      }
    }
    const timestamp = actual.toISOString().replace(/[:.]/gu, '-')
    return `${prefix}.${timestamp}.${index}${extension}`
  }
}

async function readHistoricalLogPage(
  paths: OperationsPaths,
  prefix: string,
  query: OperationsLogQuery,
): Promise<OperationsLogPage> {
  const names = (await readdir(paths.operationsRoot))
    .filter(name => name === path.basename(paths.systemLogFile)
      || (name.startsWith(`${prefix}.`) && name.endsWith('.jsonl')))
  const files = (await Promise.all(names.map(async name => {
    const filePath = path.join(paths.operationsRoot, name)
    const details = await stat(filePath)
    return { filePath, modifiedAt: details.mtimeMs, size: details.size }
  }))).sort((left, right) => right.modifiedAt - left.modifiedAt)
  const selected: typeof files = []
  let selectedBytes = 0
  for (const file of files) {
    if (selectedBytes + file.size > 32 * 1024 * 1024 && selected.length > 0) break
    selected.push(file)
    selectedBytes += file.size
  }
  const buffer = new OperationsLogBuffer([], 10_001, 32 * 1024 * 1024, {
    normalRetentionMs: Number.MAX_SAFE_INTEGER,
    sequenceOffset: 2_000_000_000,
  })
  for (const file of selected.reverse()) {
    const content = await readFile(file.filePath, 'utf8')
    for (const line of content.split(/\r?\n/gu)) {
      if (line) buffer.append({ serviceId: null, stream: 'supervisor', message: line })
    }
  }
  const page = buffer.page(query)
  return { ...page, hasMore: page.hasMore || selected.length < files.length }
}

async function pruneKnownLogFiles(
  directory: string,
  prefix: string,
  activeFile: string,
): Promise<void> {
  const names = await readdir(directory)
  const candidates = (await Promise.all(names
    .filter(name => (
      (name.startsWith(`${prefix}.`) && name.endsWith('.jsonl'))
      || /^supervisor-launch\.(?:stdout|stderr)\..+\.log$/u.test(name)
    ))
    .map(async name => {
      const filePath = path.join(directory, name)
      const details = await stat(filePath)
      return { filePath, modifiedAt: details.mtimeMs, size: details.size }
    })))
    .filter(candidate => path.resolve(candidate.filePath) !== path.resolve(activeFile))
    .sort((left, right) => left.modifiedAt - right.modifiedAt)

  const cutoff = Date.now() - RETENTION_MS
  let total = (await stat(activeFile).catch(() => null))?.size ?? 0
  for (const candidate of candidates) {
    if (candidate.modifiedAt < cutoff) {
      await unlink(candidate.filePath)
      continue
    }
    total += candidate.size
  }
  for (const candidate of candidates) {
    if (candidate.modifiedAt < cutoff || total <= TOTAL_LOG_BYTES) continue
    await unlink(candidate.filePath).catch(error => {
      if (!isMissing(error)) throw error
    })
    total -= candidate.size
  }
}

function safeMessage(error: Error): string {
  return error.message
    .replace(/[\r\n]+/gu, ' ')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|opt|mnt|srv)\/)[^\s'"<>),]+/gu, '[LOCAL_PATH]')
    .slice(0, 300)
}

function persistentLogLevel(level: string): string {
  if (level === 'silent' || level === 'fatal' || level === 'error' || level === 'warn') return level
  return 'info'
}

function sanitizePersistentRecord(
  value: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  return sanitizePersistentValue(value, secrets, new WeakSet<object>(), 0) as Record<string, unknown>
}

function sanitizePersistentValue(
  value: unknown,
  secrets: readonly string[],
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return sanitizePersistentText(value, secrets, 2_000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined
    return {
      name: value.name,
      message: sanitizePersistentText(value.message, secrets, 2_000),
      ...(code ? { code } : {}),
      ...(value.stack ? { stack: sanitizePersistentText(value.stack, secrets, 8_000) } : {}),
    }
  }
  if (typeof value !== 'object' || depth >= 5) return '[TRUNCATED]'
  if (ancestors.has(value)) return '[CIRCULAR]'
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.slice(0, 20).map(item => sanitizePersistentValue(item, secrets, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      isSensitiveLogField(key)
        ? '[REDACTED]'
        : sanitizePersistentValue(item, secrets, ancestors, depth + 1),
    ]))
  ancestors.delete(value)
  return result
}

function sanitizePersistentText(value: string, secrets: readonly string[], maxLength: number): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .slice(0, maxLength)
}

function isSensitiveLogField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SENSITIVE_LOG_FIELDS.has(normalized)
    || normalized.endsWith('prompt')
    || normalized.endsWith('requestbody')
    || normalized.endsWith('responsebody')
    || normalized.endsWith('toolarguments')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('未知文件写入错误。')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const SENSITIVE_LOG_FIELDS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'secret',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'csrftoken',
  'prompt',
  'messages',
  'input',
  'output',
  'body',
  'arguments',
  'params',
  'parameters',
  'headers',
])
