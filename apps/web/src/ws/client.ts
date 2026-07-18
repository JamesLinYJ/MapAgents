// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面客户端
//
//   文件:       client.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { WsControlCommand, WsControlResponse, WsRunPush } from '@geo-agent-platform/shared-types'
import ReconnectingWebSocket, { type CloseEvent as PartyCloseEvent } from 'partysocket/ws'
import { useConnectionStore } from '../app/stores/connectionStore'

type WsClientMessage =
  | WsRunPush
  | { type: 'connected'; id: null; payload: { data: null } }
  | { type: 'disconnected'; id: null; payload: { data: { reason: string } } }
  | { type: 'keepalive'; id: null; payload: { data: Record<string, unknown> } }

type Listener = (message: WsClientMessage) => void

interface PendingRequest {
  resolve: (message: WsControlResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 45_000
const CONNECT_WAIT_TIMEOUT_MS = 12_000
const RECONNECT_BASE_DELAY_MS = 1_200
const RECONNECT_MAX_DELAY_MS = 30_000

class WebSocketControlClient {
  private socket: ReconnectingWebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<Listener>()
  private csrfToken: string | null = null
  private authenticatedUserId: string | null = null

  async send(type: WsControlCommand, payload: Record<string, unknown>): Promise<WsControlResponse> {
    if (!this.authenticatedUserId) {
      throw new Error('请先登录后再使用实时控制功能。')
    }
    await this.ensureOpen()
    if (!this.socket || this.socket.readyState !== ReconnectingWebSocket.OPEN) {
      throw new Error('WebSocket 当前未连接，本次写命令没有发送。')
    }

    const id = `req_${crypto.randomUUID().replaceAll('-', '')}`
    const request = JSON.stringify({
      type,
      id,
      payload,
      ...(this.csrfToken ? { meta: { csrfToken: this.csrfToken } } : {}),
    })

    return new Promise<WsControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WebSocket 命令超时：${type}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        const sent = this.socket?.send(request)
        if (sent === false) throw new Error('WebSocket 当前未连接，本次写命令没有发送。')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.authenticatedUserId) void this.ensureOpen().catch(() => undefined)
    return () => this.listeners.delete(listener)
  }

  setAuthContext(userId: string | null, token: string | null): void {
    const identityChanged = this.authenticatedUserId !== userId
    const tokenChanged = this.csrfToken !== token
    this.authenticatedUserId = userId
    this.csrfToken = token
    if (identityChanged || tokenChanged) this.resetConnection('认证上下文已更新。')
    if (userId && this.listeners.size > 0) void this.ensureOpen().catch(() => undefined)
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket?.readyState === ReconnectingWebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    useConnectionStore.getState().setWsConnecting()
    const socket = this.socket ?? this.createSocket()
    const connectionPromise = new Promise<void>((resolve, reject) => {
      const cleanupWait = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('close', handleTerminalClose)
        if (this.connectPromise === connectionPromise) this.connectPromise = null
      }
      const handleOpen = () => {
        cleanupWait()
        resolve()
      }
      const handleTerminalClose = (event: PartyCloseEvent) => {
        if (!isTerminalClose(event)) return
        cleanupWait()
        reject(new Error('登录会话已失效，WebSocket 连接已关闭。'))
      }
      const timer = setTimeout(() => {
        cleanupWait()
        reject(new Error('WebSocket 重连超时，请确认 API 服务和 /ws 代理已经启动。'))
      }, CONNECT_WAIT_TIMEOUT_MS)

      socket.addEventListener('open', handleOpen)
      socket.addEventListener('close', handleTerminalClose)
    })
    this.connectPromise = connectionPromise

    return this.connectPromise
  }

  private resetConnection(reason: string): void {
    this.rejectPending(reason)
    this.connectPromise = null
    const socket = this.socket
    this.socket = null
    if (socket) socket.close(1000, reason)
    useConnectionStore.getState().setWsDisconnected(reason)
  }

  private createSocket(): ReconnectingWebSocket {
    const socket = new ReconnectingWebSocket(resolveWsUrl, undefined, {
      connectionTimeout: 8_000,
      minReconnectionDelay: RECONNECT_BASE_DELAY_MS,
      maxReconnectionDelay: RECONNECT_MAX_DELAY_MS,
      maxEnqueuedMessages: 0,
      shouldReconnectOnClose: event => !isAuthCloseCode(event.code),
    })
    this.socket = socket
    socket.addEventListener('open', () => {
      useConnectionStore.getState().setWsConnected()
      this.emit({ type: 'connected', id: null, payload: { data: null } })
    })
    socket.addEventListener('message', event => this.handleMessage(event.data))
    socket.addEventListener('close', event => {
      this.rejectPending(`WebSocket 已断开：${event.reason || event.code}`)
      const reason = event.reason || String(event.code)
      useConnectionStore.getState().setWsDisconnected(reason)
      this.emit({ type: 'disconnected', id: null, payload: { data: { reason } } })
      if (isTerminalClose(event) && this.socket === socket) this.socket = null
    })
    return socket
  }

  private handleMessage(raw: unknown) {
    const text = typeof raw === 'string' ? raw : raw instanceof Blob ? '' : String(raw)
    if (!text) return
    let message: WsControlResponse | WsRunPush | { type: string; id: string | null; payload: unknown }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }

    if (message.type === 'response') {
      const pending = message.id ? this.pending.get(message.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id!)
      const response = message as WsControlResponse
      if (isFailedResponsePayload(response.payload) && isAuthFailure(response.payload.error.message)) {
        this.emit({ type: 'disconnected', id: null, payload: { data: { reason: response.payload.error.message } } })
      }
      pending.resolve(response)
      return
    }

    this.emit(message as WsClientMessage)
  }

  private rejectPending(reason: string) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  private emit(message: WsClientMessage) {
    for (const listener of this.listeners) {
      listener(message)
    }
  }
}

export const wsClient = new WebSocketControlClient()

function resolveWsUrl() {
  const baseUrl = deriveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
  if (baseUrl) {
    const url = new URL(baseUrl, window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/ws`
    url.search = ''
    return url.toString()
  }

  const url = new URL('/ws', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function deriveApiBaseUrl(envBaseUrl?: string) {
  const explicit = envBaseUrl?.trim()
  if (!explicit || explicit === '/') {
    return ''
  }
  return explicit.replace(/\/+$/u, '')
}

function isAuthCloseCode(code: number): boolean {
  return code === 1008 || code === 4001 || code === 4401
}

function isTerminalClose(event: PartyCloseEvent): boolean {
  return isAuthCloseCode(event.code) || event.code === 1000
}

function isAuthFailure(message: string): boolean {
  return /未登录|登录会话已失效|CSRF|Unauthorized|Forbidden/iu.test(message)
}

function isFailedResponsePayload(
  payload: WsControlResponse['payload'],
): payload is { ok: false; error: { code: string; message: string } } {
  return payload.ok === false
}
