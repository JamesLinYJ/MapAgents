// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结构化日志
//
//   文件:       logger.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pino from 'pino'

// 日志严重度——模仿 Windows Event Log 的分级。
// trace:  最高细节（函数进出、变量快照）
// debug:  诊断级（请求参数、中间状态）
// info:   正常事件（启动、注册、健康检查）
// warn:   可恢复异常（重试、降级、超时）
// error:  操作失败（工具错误、Worker 失败、校验失败——包含完整上下文）
// fatal:  进程级致命（无法启动、数据库断连——类似 minidump 全量快照）
const isTestRuntime = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
const defaultLevel = isTestRuntime ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug'
const LEVEL = process.env.LOG_LEVEL || defaultLevel
const logContextStore = new AsyncLocalStorage<LogContext>()

export const logger = pino({
  level: LEVEL,
  base: { service: 'geoforge-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message',
  redact: {
    paths: [
      'authorization',
      'authorizationToken',
      'cookie',
      'csrfToken',
      'headers.authorization',
      'headers.cookie',
      'headers.set-cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.set-cookie',
      'request.headers.authorization',
      'request.headers.cookie',
      'request.headers.set-cookie',
      'sessionToken',
      '*.apiKey',
      '*.authorization',
      '*.authorizationToken',
      '*.cookie',
      '*.csrfToken',
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.sessionToken',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  // 错误序列化：自动包含 stack
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  formatters: {
    log(object) {
      return sanitizeLogValue(object) as Record<string, unknown>
    },
  },
  hooks: {
    logMethod(args, method) {
      const context = currentLogContext()
      if (!context || Object.keys(context).length === 0) {
        return method.apply(this, args)
      }
      if (args.length > 0 && isPlainRecord(args[0])) {
        const [first, ...rest] = args
        return method.apply(this, [{ ...context, ...first }, ...rest] as Parameters<typeof method>)
      }
      return method.apply(this, [context, ...args] as Parameters<typeof method>)
    },
  },
})

// traceId —— 12 位短标识，贯穿全链路
export function traceId(): string {
  return randomUUID().slice(0, 12)
}

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return logContextStore.run({ ...currentLogContext(), ...context }, fn)
}

export function currentLogContext(): LogContext {
  return logContextStore.getStore() ?? {}
}

export function childLogger(context: LogContext): pino.Logger {
  return logger.child(sanitizeLogValue(context) as Record<string, unknown>)
}

export function logHttpRequestSummary(ctx: LogContext & {
  method: string
  path: string
  statusCode: number
  durationMs: number
}): void {
  const level = ctx.statusCode >= 500 ? 'error' : ctx.statusCode >= 400 ? 'warn' : 'info'
  logger[level]({
    ...ctx,
    _summary: true,
    httpMethod: ctx.method,
    httpPath: ctx.path,
  }, 'http request completed')
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MaxDepth]'
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeLogValue(item, depth + 1))
  }
  if (value instanceof Error) return errorLogPayload(value)
  if (isPlainRecord(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      output[key] = shouldRedactKey(key) ? '[REDACTED]' : sanitizeLogValue(entry, depth + 1)
    }
    return output
  }
  return value
}

// errorLogPayload —— 结构化错误，用在 logger.error({ error: errorLogPayload(err) }, ...)
export function errorLogPayload(error: unknown): { message: string; stack?: string; name?: string; code?: string; status?: number } {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown }
    return {
      message: sanitizeString(error.message),
      stack: error.stack ? sanitizeString(error.stack) : undefined,
      name: error.name,
      code: typeof record.code === 'string' ? sanitizeString(record.code) : undefined,
      status: typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
          ? record.statusCode
          : undefined,
    }
  }
  return { message: sanitizeString(String(error)) }
}

// === 分级日志辅助函数 ===

interface LogContext {
  traceId?: string
  runId?: string
  threadId?: string
  toolName?: string
  [key: string]: unknown
}

// audit —— 安全审计事件（登录、权限变更、关键操作）
export function audit(ctx: LogContext & { action: string; actor?: string; outcome: 'allowed' | 'denied' }) {
  logger.info({ ...ctx, _audit: true }, `audit: ${ctx.action}`)
}

// event —— 业务事件（run 开始/结束、tool 调用、文件上传）
export function logEvent(level: 'info' | 'warn', ctx: LogContext & { event: string }) {
  (logger[level] as (obj: unknown, msg: string) => void)({ ...ctx, _event: true }, ctx.event)
}

// crashDump —— 致命错误全量快照（类似 minidump）。记录进程状态、内存占用、活跃句柄。
export function crashDump(ctx: LogContext & { error: unknown; phase: string }) {
  const mem = process.memoryUsage()
  logger.fatal({
    ...ctx,
    _crash: true,
    pid: process.pid,
    uptime: process.uptime(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
    error: errorLogPayload(ctx.error),
  }, `crash at ${ctx.phase}`)
}

// summary —— 请求/运行结束摘要（耗时、工具数、token 量）
export function summary(ctx: LogContext & { durationMs: number; toolCalls?: number; tokensUsed?: number }) {
  logger.info({ ...ctx, _summary: true }, `completed in ${ctx.durationMs}ms`)
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized.includes('authorization') ||
    normalized.includes('cookie') ||
    normalized.includes('csrf') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('sessiontoken') ||
    normalized === 'token' ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey') ||
    normalized === 'apikey'
  )
}

function sanitizeString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|authorization|password|secret)=)[^&#\s'"<>),]+/giu, '$1[REDACTED]')
    .replace(/file:\/\/\/?[^\s'"<>),]+/giu, '[LOCAL_PATH]')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}
