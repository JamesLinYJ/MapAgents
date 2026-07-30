// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Supervisor 结构化轮转日志
//
//   文件:       systemLogger.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import pino, {
  type Logger,
  type TransportMultiOptions,
} from 'pino'

import type { OperationsPaths } from './paths.js'

const LOG_FILE_SIZE = '16m'
const RETAINED_ROTATED_FILES = 7

export interface SupervisorLogger {
  logger: Logger
  close(): Promise<void>
}

/**
 * 使用 Pino 官方 transport 边界和 pino-roll 保存可轮转 JSONL。
 * stdout 目标保留给 systemd/WinSW 与开发启动器，文件目标负责本机故障追溯。
 */
export function createSupervisorLogger(
  paths: OperationsPaths,
  level = process.env.LOG_LEVEL ?? 'info',
  options: { includeStdout?: boolean } = {},
): SupervisorLogger {
  const targets: Array<TransportMultiOptions['targets'][number]> = []
  if (options.includeStdout !== false) {
    targets.push({
      target: 'pino/file',
      level,
      options: { destination: 1, mkdir: false, append: true },
    })
  }
  targets.push({
    target: 'pino-roll',
    level,
    options: {
      file: paths.systemLogFile,
      size: LOG_FILE_SIZE,
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      limit: {
        count: RETAINED_ROTATED_FILES,
        removeOtherLogFiles: false,
      },
    },
  })
  const transport = pino.transport({
    targets,
  })
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
        '*.password',
        '*.secret',
        '*.token',
        'authorization',
        'password',
        'secret',
        'token',
      ],
      censor: '[REDACTED]',
    },
  }, transport)
  return {
    logger,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          transport.off('close', onClose)
          reject(error)
        }
        const onClose = (): void => {
          transport.off('error', onError)
          resolve()
        }
        transport.once('error', onError)
        transport.once('close', onClose)
        transport.end()
      })
    },
  }
}
