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
import pino from 'pino'

// 日志严重度——模仿 Windows Event Log 的分级。
// trace:  最高细节（函数进出、变量快照）
// debug:  诊断级（请求参数、中间状态）
// info:   正常事件（启动、注册、健康检查）
// warn:   可恢复异常（重试、降级、超时）
// error:  操作失败（工具错误、Worker 失败、校验失败——包含完整上下文）
// fatal:  进程级致命（无法启动、数据库断连——类似 minidump 全量快照）
const LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')

export const logger = pino({
  level: LEVEL,
  base: { service: 'geoforge-api' },
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'authorization', 'cookie',
      '*.password', '*.passwordHash', '*.token', '*.secret', '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
  // 错误序列化：自动包含 stack
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
})

// traceId —— 12 位短标识，贯穿全链路
export function traceId(): string {
  return randomUUID().slice(0, 12)
}

// errorLogPayload —— 结构化错误，用在 logger.error({ error: errorLogPayload(err) }, ...)
export function errorLogPayload(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name }
  }
  return { message: String(error) }
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

