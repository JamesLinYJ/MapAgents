// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结构化日志
//
//   文件:       logger.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import pino from 'pino'

// logger
//
// 服务端统一结构化日志入口。这里不创建多套 logger，调用方通过 child()
// 追加模块、runId、threadId 或 traceId，避免裸 console 继续扩散。
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'geoforge-api',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'authorization',
      'cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  },
})

export function errorLogPayload(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    }
  }
  return { message: String(error) }
}
