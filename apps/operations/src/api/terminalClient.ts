// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维终端 WebSocket 传输层
//
//   文件:       terminalClient.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  opsTerminalServerControlSchema,
  type OpsTerminalSession,
} from '@geo-agent-platform/shared-types/operations'
import ReconnectingWebSocket from 'partysocket/ws'

export interface TerminalConnectionCallbacks {
  onOutput(data: string): void
  onScreen(data: string): void
  onState(terminal: OpsTerminalSession): void
  onConnection(connected: boolean, message: string | null): void
}

export class OpsTerminalConnection {
  private socket: ReconnectingWebSocket | null = null
  private readonly decoder = new TextDecoder()

  constructor(
    private readonly terminalId: string,
    private readonly csrfToken: string,
    private readonly callbacks: TerminalConnectionCallbacks,
  ) {}

  connect(): void {
    if (this.socket) return
    const socket = new ReconnectingWebSocket(() => terminalUrl(this.terminalId), undefined, {
      connectionTimeout: 8_000,
      minReconnectionDelay: 1_000,
      maxReconnectionDelay: 15_000,
      maxRetries: 20,
      maxEnqueuedMessages: 0,
      shouldReconnectOnClose: event => ![1000, 1008, 4001, 4401].includes(event.code),
    })
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', csrfToken: this.csrfToken }))
    })
    socket.addEventListener('message', event => { void this.handleMessage(event.data) })
    socket.addEventListener('close', event => {
      this.callbacks.onConnection(false, event.reason || `终端连接关闭（${event.code}）`)
    })
    socket.addEventListener('error', () => this.callbacks.onConnection(false, '终端连接失败。'))
  }

  sendInput(data: string): void {
    this.requireOpen().send(new TextEncoder().encode(data))
  }

  resize(cols: number, rows: number): void {
    this.requireOpen().send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  signal(signal: 'SIGINT' | 'SIGTERM'): void {
    this.requireOpen().send(JSON.stringify({ type: 'signal', signal }))
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    if (socket?.readyState === ReconnectingWebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'detach' }))
    }
    socket?.close(1000, '终端页已关闭')
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (raw instanceof ArrayBuffer) {
      this.callbacks.onOutput(this.decoder.decode(raw, { stream: true }))
      return
    }
    if (raw instanceof Blob) {
      const buffer = await raw.arrayBuffer()
      this.callbacks.onOutput(this.decoder.decode(buffer, { stream: true }))
      return
    }
    if (typeof raw !== 'string') return
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return
    }
    const parsed = opsTerminalServerControlSchema.safeParse(value)
    if (!parsed.success) return
    if (parsed.data.type === 'screen') this.callbacks.onScreen(parsed.data.data)
    if (parsed.data.type === 'state' || parsed.data.type === 'ready') {
      this.callbacks.onState(parsed.data.terminal)
      this.callbacks.onConnection(true, null)
    }
    if (parsed.data.type === 'error') this.callbacks.onConnection(false, parsed.data.message)
  }

  private requireOpen(): ReconnectingWebSocket {
    if (!this.socket || this.socket.readyState !== ReconnectingWebSocket.OPEN) {
      throw new Error('终端当前未连接。')
    }
    return this.socket
  }
}

function terminalUrl(terminalId: string): string {
  const url = new URL(`/ops/terminal/${encodeURIComponent(terminalId)}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
