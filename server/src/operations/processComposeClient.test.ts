// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Process Compose 固定 API 适配测试
//
//   文件:       processComposeClient.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProcessComposeClient } from './processComposeClient.js'

const temporaryDirectories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ProcessComposeClient', () => {
  it('校验四个固定服务、确认重启结果并对日志脱敏', async () => {
    let apiPid = 101
    let apiRestarts = 0
    const token = 'process-compose-test-token-1234567890'
    const server = createServer((request, response) => {
      expect(request.headers['x-pc-token-key']).toBe(token)
      routeProcessCompose(request, response, {
        apiPid,
        apiRestarts,
        onRestartApi: () => { apiPid = 202; apiRestarts += 1 },
      })
    })
    servers.push(server)
    const port = await listen(server)
    const directory = await createTemporaryDirectory()
    const tokenFile = path.join(directory, 'process-compose.token')
    await writeFile(tokenFile, token, 'utf8')
    const client = new ProcessComposeClient(`http://127.0.0.1:${port}`, tokenFile, 2_000)

    await client.initialize()
    const services = await client.listServices()
    expect(services.map(service => service.id)).toEqual(['web', 'api', 'worker', 'infra'])
    expect(services.find(service => service.id === 'api')).toMatchObject({ pid: 101, state: 'running', health: 'healthy' })

    const restarted = await client.performAction('api', 'restart')
    expect(restarted).toMatchObject({ id: 'api', pid: 202, restartCount: 1 })

    const logs = await client.getLogs({ services: ['api'], tail: 50 })
    expect(logs).toHaveLength(2)
    expect(logs[0]?.message).toContain('DATABASE_URL=[REDACTED]')
    expect(logs[0]?.message).not.toContain('super-secret')
    expect(logs[1]).toMatchObject({ level: 'error', message: 'request failed' })
  })

  it('服务目录缺项时硬失败，不伪造状态', async () => {
    const token = 'process-compose-test-token-1234567890'
    const server = createServer((request, response) => {
      if (request.url === '/live') return json(response, 200, { status: 'ok' })
      if (request.url === '/processes') return json(response, 200, { data: [processState('api', 101, 0)] })
      return json(response, 404, { error: 'not found' })
    })
    servers.push(server)
    const port = await listen(server)
    const directory = await createTemporaryDirectory()
    const tokenFile = path.join(directory, 'process-compose.token')
    await writeFile(tokenFile, token, 'utf8')
    const client = new ProcessComposeClient(`http://127.0.0.1:${port}`, tokenFile, 2_000)
    await expect(client.initialize()).rejects.toThrow("未注册固定服务 'web'")
  })
})

function routeProcessCompose(
  request: IncomingMessage,
  response: ServerResponse,
  state: { apiPid: number; apiRestarts: number; onRestartApi(): void },
): void {
  if (request.url === '/live') return json(response, 200, { status: 'ok' })
  if (request.url === '/processes') {
    return json(response, 200, {
      data: ['web', 'api', 'worker', 'infra'].map(name => processState(
        name,
        name === 'api' ? state.apiPid : 100,
        name === 'api' ? state.apiRestarts : 0,
      )),
    })
  }
  if (request.url === '/process/restart/api' && request.method === 'POST') {
    state.onRestartApi()
    return json(response, 200, { name: 'api' })
  }
  if (request.url === '/process/logs/api/0/50') {
    return json(response, 200, {
      logs: [
        'DATABASE_URL=postgresql://admin:super-secret@localhost/db',
        JSON.stringify({ level: 50, msg: 'request failed', time: '2026-07-21T00:00:00.000Z' }),
      ],
    })
  }
  json(response, 404, { error: 'not found' })
}

function processState(name: string, pid: number, restarts: number) {
  return {
    name,
    namespace: 'default',
    status: 'Running',
    system_time: '0',
    age: 5_000_000_000,
    is_ready: 'Ready',
    has_ready_probe: true,
    restarts,
    exit_code: -1,
    pid,
    mem: 1024,
    cpu: 1.5,
    is_running: true,
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('测试 HTTP 端口分配失败。'))
      resolve(address.port)
    })
  })
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-process-compose-'))
  temporaryDirectories.push(directory)
  return directory
}
