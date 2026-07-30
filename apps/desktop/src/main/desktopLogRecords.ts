// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志记录契约
//
//   文件:       desktopLogRecords.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  operationsLogEntrySchema,
  type OperationsLogEntry,
  type OperationsLogQuery,
} from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

const desktopFileLogRecordSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error', 'unknown']),
  scope: z.string().trim().min(1).max(80),
  processId: z.number().int().positive(),
  message: z.string().max(16_000),
}).strict()

export type DesktopFileLogRecord = z.infer<typeof desktopFileLogRecordSchema>

export function serializeDesktopFileLogRecord(input: DesktopFileLogRecord): string {
  return JSON.stringify(desktopFileLogRecordSchema.parse(input))
}

export function projectDesktopLogLines(
  lines: readonly string[],
  query: OperationsLogQuery,
): OperationsLogEntry[] {
  if (!query.includeSupervisor || query.tail === 0) return []
  const search = query.search.trim().toLocaleLowerCase('zh-CN')
  const entries: OperationsLogEntry[] = []
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line)
    if (!parsed) continue
    if (query.levels.length > 0 && !query.levels.includes(parsed.level)) continue
    if (query.streams.length > 0 && !query.streams.includes('supervisor')) continue
    if (search && !`${parsed.scope} ${parsed.message}`.toLocaleLowerCase('zh-CN').includes(search)) continue
    const sequence = 1_000_000_000 + index
    if (query.afterSequence !== null && sequence <= query.afterSequence) continue
    entries.push(operationsLogEntrySchema.parse({
      sequence,
      serviceId: null,
      component: parsed.scope,
      processId: parsed.processId,
      stream: 'supervisor',
      level: parsed.level,
      message: parsed.message,
      createdAt: parsed.createdAt,
    }))
  }
  return entries.slice(-query.tail)
}

export function desktopLogMessage(data: readonly unknown[]): string {
  return data.map(value => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return '[UNSERIALIZABLE]'
    }
  }).join(' ')
}

function parseLine(value: string): DesktopFileLogRecord | null {
  try {
    const parsed: unknown = JSON.parse(value)
    const result = desktopFileLogRecordSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
