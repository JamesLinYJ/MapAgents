// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Process Compose 1.120.0 客户端
//
//   文件:       processComposeClient.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import {
  opsLogEntrySchema,
  opsServiceSnapshotSchema,
  type OpsLogEntry,
  type OpsLogLevel,
  type OpsServiceAction,
  type OpsServiceHealth,
  type OpsServiceId,
  type OpsServiceSnapshot,
  type OpsServiceState,
} from '@geo-agent-platform/shared-types/operations'
import { WebSocket } from 'ws'
import { z } from 'zod'

import { OPS_SERVICE_IDS, OPS_SERVICE_METADATA } from './constants.js'

const processComposeStateSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  status: z.string(),
  system_time: z.string(),
  age: z.number(),
  is_ready: z.string(),
  has_ready_probe: z.boolean(),
  restarts: z.number().int().nonnegative(),
  exit_code: z.number().int(),
  pid: z.number().int(),
  mem: z.number(),
  cpu: z.number(),
  is_running: z.boolean(),
  process_start_time: z.string().datetime({ offset: true }).optional(),
  process_end_time: z.string().datetime({ offset: true }).optional(),
}).passthrough()

const processComposeProcessesSchema = z.object({ data: z.array(processComposeStateSchema) }).passthrough()
const processComposeNameSchema = z.object({ name: z.string() }).passthrough()
const processComposeLogsSchema = z.object({ logs: z.array(z.string()) }).passthrough()
const processComposeLogMessageSchema = z.object({
  message: z.string(),
  process_name: z.string(),
}).strict()
const processComposeErrorSchema = z.object({ error: z.string() }).passthrough()

export interface ProcessComposeLogSubscription {
  close(): void
}

export class ProcessComposeClient {
  private token = ''
  private logSequence = 0

  constructor(
    private readonly baseUrl: string,
    private readonly tokenFile: string,
    private readonly requestTimeoutMilliseconds = 10_000,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.token = (await readFile(this.tokenFile, 'utf8')).trim()
    } catch {
      throw new Error('Process Compose 令牌文件不可读取，Ops Gateway 已拒绝启动。')
    }
    if (this.token.length < 20) throw new Error('Process Compose 令牌长度不足 20 个字符。')
    const response = await this.fetchJson('/live', { method: 'GET' }, z.object({ status: z.string() }).passthrough())
    if (!response.status) throw new Error('Process Compose 健康响应无效。')
    await this.listServices()
  }

  async listServices(): Promise<OpsServiceSnapshot[]> {
    const payload = await this.fetchJson('/processes', { method: 'GET' }, processComposeProcessesSchema)
    const byName = new Map(payload.data.map(state => [state.name, state]))
    return OPS_SERVICE_IDS.map(id => {
      const state = byName.get(id)
      if (!state) throw new Error(`Process Compose 未注册固定服务 '${id}'。`)
      const metadata = OPS_SERVICE_METADATA[id]
      return opsServiceSnapshotSchema.parse({
        id,
        label: metadata.label,
        description: metadata.description,
        state: mapState(state.status, state.exit_code),
        health: mapHealth(state.is_ready, state.has_ready_probe, state.is_running),
        pid: state.pid > 0 ? state.pid : null,
        uptimeSeconds: state.is_running ? Math.max(0, state.age / 1_000_000_000) : null,
        restartCount: state.restarts,
        exitCode: state.status === 'Completed' || state.status === 'Error' ? state.exit_code : null,
        cpuPercent: Number.isFinite(state.cpu) ? Math.max(0, state.cpu) : null,
        memoryBytes: Number.isFinite(state.mem) ? Math.max(0, state.mem) : null,
        dependencies: metadata.dependencies,
        updatedAt: new Date().toISOString(),
      })
    })
  }

  async performAction(serviceId: OpsServiceId, action: OpsServiceAction): Promise<OpsServiceSnapshot> {
    const before = (await this.listServices()).find(service => service.id === serviceId)
    if (!before) throw new Error('服务状态不存在。')
    const endpoint = action === 'stop'
      ? `/process/stop/${encodeURIComponent(serviceId)}`
      : `/process/${action}/${encodeURIComponent(serviceId)}`
    const method = action === 'stop' ? 'PATCH' : 'POST'
    const result = await this.fetchJson(endpoint, { method }, processComposeNameSchema)
    if (result.name !== serviceId) throw new Error('Process Compose 返回了不匹配的服务标识。')
    return this.waitForAction(serviceId, action, before)
  }

  async getLogs(input: {
    services: OpsServiceId[]
    tail: number
    levels?: OpsLogLevel[]
    search?: string
  }): Promise<OpsLogEntry[]> {
    const entries: OpsLogEntry[] = []
    for (const serviceId of input.services) {
      const payload = await this.fetchJson(
        `/process/logs/${encodeURIComponent(serviceId)}/0/${Math.max(1, Math.min(5_000, input.tail))}`,
        { method: 'GET' },
        processComposeLogsSchema,
      )
      for (const line of payload.logs) {
        const entry = this.toLogEntry(serviceId, line)
        if (matchesLogFilter(entry, input.levels ?? [], input.search ?? '')) entries.push(entry)
      }
    }
    return entries
  }

  subscribeLogs(input: {
    services: OpsServiceId[]
    tail: number
    levels?: OpsLogLevel[]
    search?: string
    onEntry: (entry: OpsLogEntry) => void
    onError: (message: string) => void
  }): ProcessComposeLogSubscription {
    const url = new URL('/process/logs/ws', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('name', input.services.join(','))
    url.searchParams.set('offset', String(Math.max(0, Math.min(5_000, input.tail))))
    url.searchParams.set('follow', 'true')
    const socket = new WebSocket(url, { headers: { 'X-PC-Token-Key': this.token } })
    socket.on('message', data => {
      let value: unknown
      try {
        value = JSON.parse(data.toString()) as unknown
      } catch {
        input.onError('Process Compose 日志流响应格式无效。')
        socket.close()
        return
      }
      const parsed = processComposeLogMessageSchema.safeParse(value)
      if (!parsed.success || !isOpsServiceId(parsed.data.process_name)) {
        input.onError('Process Compose 日志流响应格式无效。')
        socket.close()
        return
      }
      const entry = this.toLogEntry(parsed.data.process_name, parsed.data.message)
      if (matchesLogFilter(entry, input.levels ?? [], input.search ?? '')) input.onEntry(entry)
    })
    socket.on('error', () => input.onError('Process Compose 日志流连接失败。'))
    return { close: () => socket.close() }
  }

  private async waitForAction(
    serviceId: OpsServiceId,
    action: OpsServiceAction,
    before: OpsServiceSnapshot,
  ): Promise<OpsServiceSnapshot> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const current = (await this.listServices()).find(service => service.id === serviceId)
      if (!current) throw new Error('服务状态不存在。')
      if (current.state === 'failed') throw new Error(`${current.label} 启动或重启失败。`)
      if (action === 'stop' && !['running', 'starting', 'stopping'].includes(current.state)) return current
      if (action === 'start' && current.state === 'running' && current.health !== 'unhealthy') return current
      if (action === 'restart' && current.state === 'running'
        && (current.restartCount > before.restartCount || current.pid !== before.pid)) return current
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`${OPS_SERVICE_METADATA[serviceId].label} 操作确认超时。`)
  }

  private toLogEntry(serviceId: OpsServiceId, rawLine: string): OpsLogEntry {
    const line = redactLogLine(rawLine).slice(0, 32_768)
    let level: OpsLogLevel = inferLogLevel(line)
    let message = line
    let timestamp = new Date().toISOString()
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (typeof record.level === 'string') level = normalizeLogLevel(record.level)
        if (typeof record.level === 'number') level = pinoLevel(record.level)
        if (typeof record.msg === 'string') message = redactLogLine(record.msg).slice(0, 32_768)
        if (typeof record.time === 'number') timestamp = new Date(record.time).toISOString()
        if (typeof record.time === 'string' && !Number.isNaN(Date.parse(record.time))) timestamp = new Date(record.time).toISOString()
      }
    } catch {
      // Process Compose 也承载非 JSON 日志；保留脱敏后的原始文本。
    }
    this.logSequence += 1
    return opsLogEntrySchema.parse({ sequence: this.logSequence, serviceId, level, message, timestamp })
  }

  private async fetchJson<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMilliseconds)
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set('X-PC-Token-Key', this.token)
      response = await fetch(new URL(path, this.baseUrl), { ...init, headers, signal: controller.signal })
    } catch {
      throw new Error('Process Compose 不可用。')
    } finally {
      clearTimeout(timeout)
    }
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsedError = processComposeErrorSchema.safeParse(payload)
      throw new Error(mapProcessComposeError(response.status, parsedError.success ? parsedError.data.error : undefined))
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new Error('Process Compose 响应格式不符合 1.120.0 协议。')
    return parsed.data
  }
}

function mapState(status: string, exitCode: number): OpsServiceState {
  if (status === 'Disabled') return 'disabled'
  if (status === 'Pending' || status === 'Scheduled') return 'pending'
  if (status === 'Launching' || status === 'Launched' || status === 'Restarting') return 'starting'
  if (status === 'Running' || status === 'Foreground') return 'running'
  if (status === 'Terminating') return 'stopping'
  if (status === 'Completed') return exitCode === 0 ? 'completed' : 'failed'
  if (status === 'Error' || status === 'Skipped') return 'failed'
  return 'unknown'
}

function mapHealth(health: string, hasProbe: boolean, running: boolean): OpsServiceHealth {
  if (health === 'Ready') return 'healthy'
  if (health === 'Not Ready') return running ? 'unhealthy' : 'starting'
  if (!hasProbe && running) return 'healthy'
  return 'unknown'
}

function mapProcessComposeError(status: number, detail?: string): string {
  if (status === 401) return 'Process Compose 认证失败。'
  if (detail?.toLowerCase().includes('not found')) return 'Process Compose 中不存在请求的固定服务。'
  return 'Process Compose 操作失败。'
}

function isOpsServiceId(value: string): value is OpsServiceId {
  return OPS_SERVICE_IDS.some(id => id === value)
}

function matchesLogFilter(entry: OpsLogEntry, levels: OpsLogLevel[], search: string): boolean {
  if (levels.length && !levels.includes(entry.level)) return false
  return !search.trim() || entry.message.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
}

function inferLogLevel(line: string): OpsLogLevel {
  if (/\b(fatal|panic)\b/iu.test(line)) return 'fatal'
  if (/\b(error|exception|failed)\b/iu.test(line)) return 'error'
  if (/\bwarn(?:ing)?\b/iu.test(line)) return 'warn'
  if (/\bdebug\b/iu.test(line)) return 'debug'
  if (/\btrace\b/iu.test(line)) return 'trace'
  return 'info'
}

function normalizeLogLevel(value: string): OpsLogLevel {
  const normalized = value.toLowerCase()
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(normalized)
    ? normalized as OpsLogLevel
    : 'unknown'
}

function pinoLevel(value: number): OpsLogLevel {
  if (value >= 60) return 'fatal'
  if (value >= 50) return 'error'
  if (value >= 40) return 'warn'
  if (value >= 30) return 'info'
  if (value >= 20) return 'debug'
  return 'trace'
}

export function redactLogLine(line: string): string {
  return line
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, '$1[REDACTED]@')
}
