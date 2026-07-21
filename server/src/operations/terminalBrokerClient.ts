// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker 客户端
//
//   文件:       terminalBrokerClient.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'
import WebSocket from 'ws'

import {
  applyBrokerSignature,
  signBrokerRequest,
} from './brokerAuthentication.js'
import {
  brokerCreateTerminalSchema,
  brokerTerminalSessionSchema,
  brokerTranscriptChunkSchema,
  type BrokerCreateTerminal,
  type BrokerTerminalSession,
  type BrokerTranscriptChunk,
} from './brokerProtocol.js'

const brokerInfoSchema = z.object({
  status: z.literal('ok'),
  terminalAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  shell: z.string().nullable(),
}).strict()

const acknowledgeSchema = z.object({ acknowledged: z.literal(true) }).strict()

export type BrokerInfo = z.infer<typeof brokerInfoSchema>

export class TerminalBrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalBrokerUnavailableError'
  }
}

/**
 * TerminalBrokerClient 是 Gateway 到低权限 Broker 的唯一协议边界。
 * 所有请求均绑定 method/path/body 并校验响应，调用方不会接触共享密钥。
 */
export class TerminalBrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
  ) {}

  getInfo(): Promise<BrokerInfo> {
    return this.request('/internal/v1/info', { method: 'GET' }, brokerInfoSchema)
  }

  listSessions(): Promise<BrokerTerminalSession[]> {
    return this.request(
      '/internal/v1/sessions',
      { method: 'GET' },
      z.array(brokerTerminalSessionSchema),
    )
  }

  createSession(input: BrokerCreateTerminal): Promise<BrokerTerminalSession> {
    return this.request(
      '/internal/v1/sessions',
      { method: 'POST', body: JSON.stringify(brokerCreateTerminalSchema.parse(input)) },
      brokerTerminalSessionSchema,
    )
  }

  terminateSession(terminalId: string): Promise<BrokerTerminalSession> {
    return this.request(
      `/internal/v1/sessions/${encodeURIComponent(terminalId)}`,
      { method: 'DELETE' },
      brokerTerminalSessionSchema,
    )
  }

  listChunks(limit = 100): Promise<BrokerTranscriptChunk[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)))
    return this.request(
      `/internal/v1/chunks?limit=${safeLimit}`,
      { method: 'GET' },
      z.array(brokerTranscriptChunkSchema),
    )
  }

  async acknowledgeChunk(chunkId: string): Promise<void> {
    await this.request(
      `/internal/v1/chunks/${encodeURIComponent(chunkId)}`,
      { method: 'DELETE' },
      acknowledgeSchema,
    )
  }

  openTerminal(terminalId: string): WebSocket {
    const endpoint = new URL(
      `/internal/v1/terminal/${encodeURIComponent(terminalId)}`,
      this.baseUrl,
    )
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const pathAndQuery = `${endpoint.pathname}${endpoint.search}`
    const headers = new Headers()
    applyBrokerSignature(headers, signBrokerRequest({
      method: 'GET',
      pathAndQuery,
      body: new Uint8Array(),
      secret: this.sharedSecret,
    }))
    return new WebSocket(endpoint, { headers: Object.fromEntries(headers.entries()) })
  }

  private async request<T>(
    pathAndQuery: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const body = init.body ? Buffer.from(init.body, 'utf8') : Buffer.alloc(0)
    const headers = new Headers()
    if (body.byteLength) headers.set('content-type', 'application/json')
    applyBrokerSignature(headers, signBrokerRequest({
      method: init.method,
      pathAndQuery,
      body,
      secret: this.sharedSecret,
    }))
    let response: Response
    try {
      const requestInit: RequestInit = {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(5_000),
      }
      if (body.byteLength) requestInit.body = body
      response = await fetch(new URL(pathAndQuery, this.baseUrl), requestInit)
    } catch {
      throw new TerminalBrokerUnavailableError('Terminal Broker 当前不可用。')
    }
    if (!response.ok) {
      throw new TerminalBrokerUnavailableError(`Terminal Broker 请求失败（HTTP ${response.status}）。`)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error('Terminal Broker 返回了无效 JSON。')
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new Error('Terminal Broker 响应不符合协议。')
    return parsed.data
  }
}
