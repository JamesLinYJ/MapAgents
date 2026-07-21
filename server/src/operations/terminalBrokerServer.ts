// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker HTTP 与 WebSocket 服务
//
//   文件:       terminalBrokerServer.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createServer, type IncomingMessage } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

import { OPS_LIMITS } from './constants.js'
import { BrokerNonceCache, verifyBrokerRequest } from './brokerAuthentication.js'
import type { TerminalBrokerEnvironment } from './config.js'
import type { TerminalManager } from './terminalManager.js'
import type { TranscriptSpool } from './transcriptSpool.js'

export function createTerminalBrokerServer(input: {
  environment: TerminalBrokerEnvironment
  manager: TerminalManager
  spool: TranscriptSpool
}) {
  const { environment, manager, spool } = input
  const nonces = new BrokerNonceCache()
  const app = new Hono()

  app.get('/health', c => c.json({ status: 'ok', component: 'terminal-broker' }))
  app.use('/internal/*', async (c, next) => {
    const body = new Uint8Array(await c.req.raw.clone().arrayBuffer())
    const url = new URL(c.req.url)
    if (!verifyBrokerRequest({
      method: c.req.method,
      pathAndQuery: `${url.pathname}${url.search}`,
      body,
      secret: environment.OPS_BROKER_SHARED_SECRET,
      headers: c.req.raw.headers,
      nonces,
    })) return c.json({ detail: 'Broker 内部认证失败。' }, 401)
    await next()
  })
  app.get('/internal/v1/info', c => c.json({
    status: 'ok',
    terminalAvailable: true,
    unavailableReason: null,
    shell: environment.shell,
  }))
  app.get('/internal/v1/sessions', c => c.json(manager.list()))
  app.post('/internal/v1/sessions', async c => {
    const created = await manager.create(await c.req.json())
    return c.json(created, 201)
  })
  app.delete('/internal/v1/sessions/:terminalId', async c => {
    const session = await manager.terminate(c.req.param('terminalId'))
    return c.json(session)
  })
  app.get('/internal/v1/chunks', async c => {
    const limit = Number(c.req.query('limit') ?? '100')
    return c.json(await spool.list(limit))
  })
  app.delete('/internal/v1/chunks/:chunkId', async c => {
    await spool.acknowledge(c.req.param('chunkId'))
    return c.json({ acknowledged: true })
  })
  app.onError(() => new Response(JSON.stringify({ detail: 'Terminal Broker 处理失败。' }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }))

  const server = createServer(getRequestListener(app.fetch))
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: OPS_LIMITS.maximumFrameBytes })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const match = /^\/internal\/v1\/terminal\/([^/]+)$/u.exec(url.pathname)
    const terminalId = match?.[1] ? decodeURIComponent(match[1]) : null
    if (!terminalId || !verifyUpgrade(request, url, environment.OPS_BROKER_SHARED_SECRET, nonces)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wsServer.handleUpgrade(request, socket, head, client => {
      wsServer.emit('connection', client, request, terminalId)
    })
  })
  wsServer.on('connection', (client: WebSocket, _request: IncomingMessage, terminalIdValue: unknown) => {
    if (typeof terminalIdValue !== 'string') {
      client.close(1008, '终端标识无效')
      return
    }
    const terminalId = terminalIdValue
    try {
      manager.attach(terminalId, client)
    } catch {
      client.close(1008, '终端会话不可用')
      return
    }
    client.on('message', (data, isBinary) => {
      try {
        if (isBinary) manager.receiveBinary(terminalId, rawDataBytes(data))
        else manager.receiveControl(terminalId, JSON.parse(data.toString()) as unknown)
      } catch {
        client.send(JSON.stringify({ type: 'error', message: '终端输入或控制帧无效。' }))
        client.close(1008, '终端帧无效')
      }
    })
    client.on('close', () => manager.detachClient(terminalId, client))
  })

  return { app, server, wsServer }
}

function verifyUpgrade(
  request: IncomingMessage,
  url: URL,
  secret: string,
  nonces: BrokerNonceCache,
): boolean {
  return verifyBrokerRequest({
    method: 'GET',
    pathAndQuery: `${url.pathname}${url.search}`,
    body: new Uint8Array(),
    secret,
    headers: incomingHeaders(request),
    nonces,
  })
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  return headers
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return data
}
