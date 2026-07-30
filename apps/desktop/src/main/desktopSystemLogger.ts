// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 主进程系统日志
//
//   文件:       desktopSystemLogger.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { app } from 'electron'
import log from 'electron-log/main'
import path from 'node:path'
import type {
  OperationsLogEntry,
  OperationsLogQuery,
} from '@geo-agent-platform/shared-types/operations'

import {
  collectDesktopLogSecrets,
  sanitizeDesktopLogValue,
} from './desktopLogSanitizer.js'
import {
  desktopLogMessage,
  projectDesktopLogLines,
  serializeDesktopFileLogRecord,
} from './desktopLogRecords.js'

export interface DesktopSystemLogger {
  readonly filePath: string
  debug(event: string, details?: Record<string, unknown>): void
  info(event: string, details?: Record<string, unknown>): void
  warn(event: string, details?: Record<string, unknown>): void
  error(event: string, error?: unknown, details?: Record<string, unknown>): void
  read(query: OperationsLogQuery): Promise<OperationsLogEntry[]>
  close(): void
}

/**
 * electron-log 负责轮转、Electron 崩溃事件与未捕获异常；GeoForge 包装层只允许
 * 结构化事件，并在任何 transport 之前统一脱敏。
 */
export function createDesktopSystemLogger(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopSystemLogger {
  const secrets = collectDesktopLogSecrets(environment)
  const filePath = path.join(app.getPath('logs'), 'desktop-main.log')
  log.transports.file.resolvePathFn = () => filePath
  log.transports.file.maxSize = 8 * 1024 * 1024
  log.transports.file.format = ({ message }) => [serializeDesktopFileLogRecord({
    version: 1,
    createdAt: message.date.toISOString(),
    level: message.level === 'verbose' || message.level === 'silly'
      ? 'debug'
      : message.level,
    scope: message.scope || 'desktop',
    processId: process.pid,
    message: desktopLogMessage(message.data),
  })]
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}'
  log.hooks.push(message => ({
    ...message,
    data: message.data.map(value => sanitizeDesktopLogValue(value, secrets)),
  }))
  // Renderer 只允许 GeoForge 自有的窄 Preload；不要让日志组件注入第二个桥。
  log.initialize({ preload: false, spyRendererConsole: false })
  log.errorHandler.startCatching({ showDialog: false })
  log.eventLogger.startLogging({
    level: 'error',
    scope: 'electron',
  })
  const scoped = log.scope('desktop')

  const write = (
    level: 'debug' | 'info' | 'warn',
    event: string,
    details?: Record<string, unknown>,
  ): void => {
    scoped[level](event, details ?? {})
  }
  return {
    filePath,
    debug: (event, details) => write('debug', event, details),
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, error, details) => {
      scoped.error(event, {
        ...details,
        ...(error === undefined ? {} : { error }),
      })
    },
    read: async query => {
      const logs = log.transports.file.readAllLogs({
        fileFilter: logPath => path.basename(logPath).startsWith('desktop-main'),
      })
      return projectDesktopLogLines(
        logs.flatMap(file => file.lines),
        query,
      )
    },
    close: () => {
      log.eventLogger.stopLogging()
      log.errorHandler.stopCatching()
    },
  }
}
