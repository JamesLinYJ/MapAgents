// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 监督日志内存缓冲
//
//   文件:       logBuffer.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  OperationsLogEntry,
  OperationsLogFilter,
  OperationsLogQuery,
  OperationsServiceId,
} from '@geo-agent-platform/shared-types/operations'
import stripAnsi from 'strip-ansi'

const MAX_LINE_BYTES = 60 * 1024

export class OperationsLogBuffer {
  private readonly entries: OperationsLogEntry[] = []
  private byteSize = 0
  private sequence = 0

  constructor(
    private readonly secrets: readonly string[],
    private readonly maxEntries = 10_000,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  append(input: {
    serviceId: OperationsServiceId | null
    stream: OperationsLogEntry['stream']
    message: string
    level?: OperationsLogEntry['level']
    component?: string | null
    processId?: number | null
    createdAt?: Date
  }): OperationsLogEntry {
    const sanitized = this.redact(sanitizeLogLine(input.message))
    const structured = parseStructuredLog(sanitized)
    const prefixed = parseComponentPrefix(structured?.message ?? sanitized, input.serviceId)
    const message = truncateUtf8(prefixed.message, MAX_LINE_BYTES)
    const entry: OperationsLogEntry = {
      sequence: ++this.sequence,
      serviceId: input.serviceId,
      component: normalizeComponent(input.component)
        ?? structured?.component
        ?? prefixed.component,
      processId: normalizeProcessId(input.processId)
        ?? structured?.processId
        ?? null,
      stream: input.stream,
      level: input.level
        ?? (structured?.level && structured.level !== 'unknown'
        ? structured.level
        : inferLevel(message, input.stream)),
      message,
      createdAt: (input.createdAt ?? structured?.createdAt ?? new Date()).toISOString(),
    }
    this.entries.push(entry)
    this.byteSize += Buffer.byteLength(message, 'utf8')
    while (this.entries.length > this.maxEntries || this.byteSize > this.maxBytes) {
      const removed = this.entries.shift()
      if (!removed) break
      this.byteSize -= Buffer.byteLength(removed.message, 'utf8')
    }
    return entry
  }

  tail(services: readonly OperationsServiceId[], count: number): OperationsLogEntry[] {
    return this.query({
      services: [...services],
      levels: [],
      streams: [],
      search: '',
      includeSupervisor: false,
      afterSequence: null,
      tail: count,
    })
  }

  query(query: OperationsLogQuery): OperationsLogEntry[] {
    if (query.tail === 0) return []
    return this.entries
      .filter(entry => matchesOperationsLogFilter(entry, query))
      .slice(-query.tail)
  }

  private redact(value: string): string {
    let result = value
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]')
    return result
  }
}

export function matchesOperationsLogFilter(
  entry: OperationsLogEntry,
  filter: OperationsLogFilter,
): boolean {
  if (entry.serviceId === null) {
    if (!filter.includeSupervisor) return false
  } else if (!filter.services.includes(entry.serviceId)) {
    return false
  }
  if (filter.levels.length > 0 && !filter.levels.includes(entry.level)) return false
  if (filter.streams.length > 0 && !filter.streams.includes(entry.stream)) return false
  if (filter.afterSequence !== null && entry.sequence <= filter.afterSequence) return false
  if (filter.search && !searchableLogText(entry).includes(filter.search.toLocaleLowerCase('zh-CN'))) return false
  return true
}

export class LineDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private pending = ''

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true })
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines
  }

  finish(): string[] {
    this.pending += this.decoder.decode()
    if (!this.pending) return []
    const value = this.pending
    this.pending = ''
    return [value]
  }
}

function inferLevel(message: string, stream: OperationsLogEntry['stream']): OperationsLogEntry['level'] {
  if (/\b(error|fatal|exception|失败|错误)\b/iu.test(message)) return 'error'
  if (/\b(warn|warning|警告)\b/iu.test(message)) return 'warn'
  if (/\b(debug|trace|调试)\b/iu.test(message)) return 'debug'
  if (/\b(info|ready|started|healthy|完成|就绪|启动)\b/iu.test(message)) return 'info'
  if (stream === 'stderr') return 'warn'
  return 'unknown'
}

function sanitizeLogLine(value: string): string {
  return stripAnsi(value.replace(/\r$/u, ''))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes - 3) end -= 1
  return `${value.slice(0, end)}…`
}

interface StructuredLogProjection {
  message: string
  level: OperationsLogEntry['level']
  component: string | null
  processId: number | null
  createdAt: Date | undefined
}

function parseStructuredLog(value: string): StructuredLogProjection | null {
  if (!value.startsWith('{') || !value.endsWith('}')) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const rawMessage = typeof record.msg === 'string'
      ? record.msg
      : typeof record.message === 'string'
        ? record.message
        : null
    if (!rawMessage) return null
    return {
      message: rawMessage,
      level: structuredLevel(record.level),
      component: normalizeComponent(record.component)
        ?? normalizeComponent(record.service)
        ?? normalizeComponent(record.name),
      processId: normalizeProcessId(record.pid),
      createdAt: structuredTimestamp(record.time),
    }
  } catch {
    return null
  }
}

function structuredLevel(value: unknown): OperationsLogEntry['level'] {
  if (typeof value === 'number') {
    if (value >= 50) return 'error'
    if (value >= 40) return 'warn'
    if (value >= 30) return 'info'
    return 'debug'
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (normalized === 'fatal' || normalized === 'error') return 'error'
    if (normalized === 'warn' || normalized === 'warning') return 'warn'
    if (normalized === 'info') return 'info'
    if (normalized === 'debug' || normalized === 'trace') return 'debug'
  }
  return 'unknown'
}

function structuredTimestamp(value: unknown): Date | undefined {
  const date = typeof value === 'number'
    ? new Date(value)
    : typeof value === 'string'
      ? new Date(value)
      : null
  return date && Number.isFinite(date.getTime()) ? date : undefined
}

function parseComponentPrefix(
  value: string,
  serviceId: OperationsServiceId | null,
): { message: string; component: string | null } {
  const matched = /^\[([a-zA-Z0-9_-]{1,80})\]\s*/u.exec(value)
  if (!matched?.[1]) return { message: value, component: null }
  return {
    message: value.slice(matched[0].length),
    component: matched[1] === serviceId ? null : matched[1],
  }
}

function normalizeComponent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().slice(0, 80)
  return normalized ? normalized : null
}

function normalizeProcessId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

function searchableLogText(entry: OperationsLogEntry): string {
  return [
    entry.serviceId ?? 'supervisor',
    entry.component ?? '',
    entry.stream,
    entry.level,
    entry.message,
  ].join(' ').toLocaleLowerCase('zh-CN')
}
