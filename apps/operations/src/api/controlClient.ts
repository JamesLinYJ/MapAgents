// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维控制 WebSocket 客户端
//
//   文件:       controlClient.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  opsControlErrorSchema,
  opsControlSuccessSchema,
  opsPushEventSchema,
  type OpsLogLevel,
  type OpsPushEvent,
  type OpsServiceAction,
  type OpsServiceId,
} from '@geo-agent-platform/shared-types/operations'
import ReconnectingWebSocket from 'partysocket/ws'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type PushListener = (event: OpsPushEvent) => void
type ConnectionListener = (connected: boolean, message: string | null) => void

const REQUEST_TIMEOUT_MILLISECONDS = 45_000

class OpsControlClient {
  private socket: ReconnectingWebSocket | null = null
  private csrfToken: string | null = null
  private userId: string | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly pushListeners = new Set<PushListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()
  private metricsSubscribed = false
  private logSubscription: {
    services: OpsServiceId[]
    levels: OpsLogLevel[]
    search: string
    tail: number
  } | null = null

  setAuth(userId: string | null, csrfToken: string | null): void {
    if (this.userId === userId && this.csrfToken === csrfToken) return
    this.userId = userId
    this.csrfToken = csrfToken
    this.reconnect('认证上下文已更新')
  }

  refreshCredentials(): void {
    this.reconnect('二次验证状态已更新')
  }

  onPush(listener: PushListener): () => void {
    this.pushListeners.add(listener)
    if (this.userId && this.csrfToken) void this.ensureSocket().catch(() => undefined)
    return () => this.pushListeners.delete(listener)
  }

  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  async subscribeMetrics(): Promise<void> {
    this.metricsSubscribed = true
    await this.send({ type: 'subscribe_metrics' })
  }

  async subscribeLogs(input: {
    services: OpsServiceId[]
    levels: OpsLogLevel[]
    search: string
    tail: number
  }): Promise<void> {
    this.logSubscription = structuredClone(input)
    await this.send({ type: 'subscribe_logs', ...input })
  }

  serviceAction(serviceId: OpsServiceId, action: OpsServiceAction, confirmation?: string) {
    return this.send({
      type: 'service_action',
      serviceId,
      action,
      ...(confirmation === undefined ? {} : { confirmation }),
    })
  }

  createTerminal(label: string, cols: number, rows: number) {
    return this.send({ type: 'terminal_create', label, cols, rows })
  }

  listTerminals() {
    return this.send({ type: 'terminal_list' })
  }

  closeTerminal(terminalId: string) {
    return this.send({ type: 'terminal_close', terminalId })
  }

  close(): void {
    this.metricsSubscribed = false
    this.logSubscription = null
    this.reconnect('客户端已关闭', false)
  }

  private async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.userId || !this.csrfToken) throw new Error('请先登录运维后台。')
    const socket = await this.ensureSocket()
    const requestId = `ops_${crypto.randomUUID().replaceAll('-', '')}`
    const payload = JSON.stringify({ ...command, requestId, csrfToken: this.csrfToken })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('运维控制命令等待确认超时。'))
      }, REQUEST_TIMEOUT_MILLISECONDS)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        socket.send(payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('运维控制命令发送失败。'))
      }
    })
  }

  private ensureSocket(): Promise<ReconnectingWebSocket> {
    if (!this.userId || !this.csrfToken) return Promise.reject(new Error('请先登录运维后台。'))
    const socket = this.socket ?? this.createSocket()
    if (socket.readyState === ReconnectingWebSocket.OPEN) return Promise.resolve(socket)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Ops Gateway WebSocket 连接超时。'))
      }, 12_000)
      const onOpen = () => { cleanup(); resolve(socket) }
      const onClose = () => {
        if (socket.readyState === ReconnectingWebSocket.CLOSED) {
          cleanup()
          reject(new Error('Ops Gateway WebSocket 已关闭。'))
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('close', onClose)
    })
  }

  private createSocket(): ReconnectingWebSocket {
    const socket = new ReconnectingWebSocket(resolveControlUrl, undefined, {
      connectionTimeout: 8_000,
      minReconnectionDelay: 1_000,
      maxReconnectionDelay: 20_000,
      maxEnqueuedMessages: 0,
      shouldReconnectOnClose: event => ![1000, 1008, 4001, 4401].includes(event.code),
    })
    this.socket = socket
    socket.addEventListener('open', () => {
      this.emitConnection(true, null)
      if (this.metricsSubscribed) void this.send({ type: 'subscribe_metrics' }).catch(() => undefined)
      if (this.logSubscription) {
        void this.send({ type: 'subscribe_logs', ...this.logSubscription }).catch(() => undefined)
      }
    })
    socket.addEventListener('message', event => { void this.handleMessage(event.data) })
    socket.addEventListener('close', event => {
      this.emitConnection(false, event.reason || `连接关闭（${event.code}）`)
      this.rejectPending('Ops Gateway WebSocket 已断开。')
    })
    socket.addEventListener('error', () => this.emitConnection(false, 'Ops Gateway WebSocket 连接失败。'))
    return socket
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw instanceof Blob ? await raw.text() : ''
    if (!text) return
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      return
    }
    const push = opsPushEventSchema.safeParse(value)
    if (push.success) {
      for (const listener of this.pushListeners) listener(push.data)
      return
    }
    const success = opsControlSuccessSchema.safeParse(value)
    const failure = opsControlErrorSchema.safeParse(value)
    const response = success.success ? success.data : failure.success ? failure.data : null
    if (!response) return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    if (response.ok) pending.resolve(response.data)
    else pending.reject(new Error(response.error.message))
  }

  private reconnect(reason: string, reopen = true): void {
    this.rejectPending(reason)
    const existing = this.socket
    this.socket = null
    existing?.close(1000, reason)
    if (reopen && this.userId && this.pushListeners.size) void this.ensureSocket().catch(() => undefined)
  }

  private rejectPending(message: string): void {
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
      this.pending.delete(requestId)
    }
  }

  private emitConnection(connected: boolean, message: string | null): void {
    for (const listener of this.connectionListeners) listener(connected, message)
  }
}

export const opsControlClient = new OpsControlClient()

function resolveControlUrl(): string {
  const url = new URL('/ops/ws', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
