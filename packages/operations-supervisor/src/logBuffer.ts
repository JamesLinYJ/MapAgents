// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 监督日志内存缓冲
//
//   文件:       logBuffer.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OperationsLogEntry, OperationsServiceId } from '@geo-agent-platform/shared-types/operations'
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
    createdAt?: Date
  }): OperationsLogEntry {
    const message = truncateUtf8(this.redact(sanitizeLogLine(input.message)), MAX_LINE_BYTES)
    const entry: OperationsLogEntry = {
      sequence: ++this.sequence,
      serviceId: input.serviceId,
      stream: input.stream,
      level: inferLevel(message, input.stream),
      message,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
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
    if (count === 0) return []
    const allowed = new Set(services)
    return this.entries.filter(entry => entry.serviceId !== null && allowed.has(entry.serviceId)).slice(-count)
  }

  private redact(value: string): string {
    let result = value
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]')
    return result
  }
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

function inferLevel(message: string, _stream: OperationsLogEntry['stream']): OperationsLogEntry['level'] {
  if (/\b(error|fatal|exception|失败|错误)\b/iu.test(message)) return 'error'
  if (/\b(warn|warning|警告)\b/iu.test(message)) return 'warn'
  if (/\b(debug|trace|调试)\b/iu.test(message)) return 'debug'
  if (/\b(info|ready|started|healthy|完成|就绪|启动)\b/iu.test(message)) return 'info'
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
