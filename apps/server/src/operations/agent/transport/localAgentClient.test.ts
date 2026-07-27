// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机 Agent WebSocket 客户端测试
//
//   文件:       localAgentClient.test.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { once } from 'node:events'

import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { LocalAgentClient, localAgentWsUrl } from './localAgentClient.js'

const servers: WebSocketServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('LocalAgentClient', () => {
  it('sends the Better Auth cookie, trusted Origin and CSRF metadata over JSONL', async () => {
    const received = vi.fn()
    const server = await openServer((socket, request) => {
      expect(request.headers.cookie).toBe('better-auth.session_token=local')
      expect(request.headers.origin).toBe('http://127.0.0.1:8000')
      socket.on('message', data => {
        const frame: unknown = JSON.parse(data.toString().trim())
        received(frame)
        const id = isRecord(frame) && typeof frame.id === 'string' ? frame.id : null
        const response = `${JSON.stringify({
          type: 'response',
          id,
          payload: { ok: true, data: { status: 'ready' } },
        })}\n`
        const midpoint = Math.floor(response.length / 2)
        socket.send(response.slice(0, midpoint))
        socket.send(response.slice(midpoint))
      })
    })
    const client = await connect(server)

    await expect(client.send(
      'run:get',
      { runId: 'run_1' },
      z.object({ status: z.literal('ready') }),
    )).resolves.toEqual({ status: 'ready' })

    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run:get',
      payload: { runId: 'run_1' },
      meta: { csrfToken: 'csrf-local-agent' },
    }))
    client.close()
  })

  it('delivers only recognized server push envelopes', async () => {
    const server = await openServer(socket => {
      setTimeout(() => {
        socket.send(`${JSON.stringify({
          type: 'run.item',
          id: null,
          payload: { data: { itemId: 'item_1' } },
        })}\n`)
        socket.send(`${JSON.stringify({
          type: 'untrusted.extension',
          id: null,
          payload: { data: 'ignored' },
        })}\n`)
      }, 5)
    })
    const client = await connect(server)
    const pushes: string[] = []
    client.onPush(message => pushes.push(message.type))

    await vi.waitFor(() => expect(pushes).toEqual(['run.item']))
    client.close()
  })

  it('hard-fails malformed protocol responses and rejects pending writes', async () => {
    const server = await openServer(socket => {
      socket.on('message', () => socket.send('{not-json}\n'))
    })
    const client = await connect(server)
    const disconnected = vi.fn()
    client.onDisconnected(disconnected)

    await expect(client.send('run:get', { runId: 'run_1' }, z.unknown()))
      .rejects.toThrow('不是合法 JSON')
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('rejects requests above the 64 KiB protocol limit before transmission', async () => {
    const received = vi.fn()
    const server = await openServer(socket => socket.on('message', received))
    const client = await connect(server)

    await expect(client.send('run:start', { query: '杭'.repeat(70_000) }, z.unknown()))
      .rejects.toThrow('超过 64 KiB')
    expect(received).not.toHaveBeenCalled()
    client.close()
  })

  it('requires a session cookie and normalizes only HTTP(S) endpoints', async () => {
    expect(localAgentWsUrl('https://example.test:8443/api?secret=no')).toBe('wss://example.test:8443/ws')
    expect(() => localAgentWsUrl('file:///tmp/geoforge')).toThrow('http 或 https')

    await expect(LocalAgentClient.connect({
      appBaseUrl: 'http://127.0.0.1:1',
      origin: 'http://127.0.0.1:8000',
      headers: new Headers(),
      csrfToken: 'csrf',
      timeoutMs: 10,
    })).rejects.toThrow('缺少 Better Auth Cookie')
  })
})

async function openServer(
  onConnection: (socket: WebSocket, request: import('node:http').IncomingMessage) => void,
): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  server.on('connection', onConnection)
  await once(server, 'listening')
  return server
}

async function connect(server: WebSocketServer): Promise<LocalAgentClient> {
  const address = server.address() as AddressInfo
  return LocalAgentClient.connect({
    appBaseUrl: `http://127.0.0.1:${address.port}`,
    origin: 'http://127.0.0.1:8000',
    headers: new Headers({ cookie: 'better-auth.session_token=local' }),
    csrfToken: 'csrf-local-agent',
    timeoutMs: 2_000,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
