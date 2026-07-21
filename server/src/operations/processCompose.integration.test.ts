// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Process Compose 真实监督器集成测试
//
//   文件:       processCompose.integration.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProcessComposeClient } from './processComposeClient.js'

const executable = process.env.GEOFORGE_PROCESS_COMPOSE_BIN
const children: ChildProcess[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
    await waitForExit(child, 5_000).catch(() => child.kill('SIGKILL'))
  }
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe.skipIf(!executable)('Process Compose 1.120.0 真实监督器', () => {
  it('按依赖启动四个服务、提供日志并确认 API 重启', async () => {
    if (!executable) throw new Error('缺少 GEOFORGE_PROCESS_COMPOSE_BIN。')
    const repositoryRoot = path.resolve(process.cwd(), '..')
    const fixture = path.join(process.cwd(), 'src', 'operations', 'fixtures', 'process-compose.integration.yaml')
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-process-compose-live-'))
    temporaryDirectories.push(directory)
    const tokenFile = path.join(directory, 'token')
    const logFile = path.join(directory, 'process-compose.log')
    const token = 'actual-process-compose-test-token-123456789'
    await writeFile(tokenFile, token, 'utf8')
    const port = await reservePort()
    const child = spawn(executable, [
      '--address', '127.0.0.1',
      '--port', String(port),
      '--token-file', tokenFile,
      '--log-file', logFile,
      '--ordered-shutdown',
      '-f', fixture,
      'up',
      '--keep-project',
      '--tui=false',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, GEOFORGE_ROOT: repositoryRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    let stderr = ''
    let stdout = ''
    child.stderr?.on('data', data => { stderr += data.toString() })
    child.stdout?.on('data', data => { stdout += data.toString() })
    await waitForLive(`http://127.0.0.1:${port}`, token, child, () => `${stdout}\n${stderr}`)

    const client = new ProcessComposeClient(`http://127.0.0.1:${port}`, tokenFile, 3_000)
    await client.initialize()
    const before = await waitForHealthyServices(client).catch(async error => {
      throw new Error(`${error instanceof Error ? error.message : '监督器服务未运行'}：${await readFile(logFile, 'utf8').catch(() => '缺少日志')}`)
    })
    expect(before.map(service => service.id)).toEqual(['web', 'api', 'worker', 'infra'])
    expect(before.every(service => service.state === 'running')).toBe(true)
    expect(before.every(service => service.health === 'healthy')).toBe(true)
    const apiBefore = before.find(service => service.id === 'api')
    expect(apiBefore?.pid).not.toBeNull()

    const logs = await client.getLogs({ services: ['api'], tail: 50, search: 'fixture ready' })
    expect(logs.some(entry => entry.message.includes('api fixture ready'))).toBe(true)

    let subscription: { close(): void } | null = null
    const streamed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Process Compose 日志 WebSocket 等待超时。')), 5_000)
      subscription = client.subscribeLogs({
        services: ['api'],
        tail: 10,
        onEntry: entry => {
          if (!entry.message.includes('api fixture')) return
          clearTimeout(timer)
          resolve(entry.message)
        },
        onError: message => {
          clearTimeout(timer)
          reject(new Error(message))
        },
      })
    }).finally(() => subscription?.close())
    expect(streamed).toContain('api fixture')

    const restarted = await client.performAction('api', 'restart')
    expect(restarted.state).toBe('running')
    expect(restarted.pid).not.toBe(apiBefore?.pid)
  }, 30_000)
})

async function reservePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配监督器测试端口。'))
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitForHealthyServices(client: ProcessComposeClient) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const services = await client.listServices()
    if (services.every(service => service.state === 'running' && service.health === 'healthy')) return services
    if (services.some(service => service.state === 'failed')) throw new Error('Process Compose 依赖启动失败')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Process Compose 服务未在 15 秒内健康')
}

async function waitForLive(
  baseUrl: string,
  token: string,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Process Compose 提前退出：${stderr()}`)
    try {
      const response = await fetch(`${baseUrl}/live`, {
        headers: { 'X-PC-Token-Key': token },
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return
    } catch {
      // 监督器监听与依赖启动存在短暂窗口，继续有界轮询。
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Process Compose 未在 15 秒内就绪：${stderr()}`)
}

async function waitForExit(child: ChildProcess, timeoutMilliseconds: number): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('进程退出超时。')), timeoutMilliseconds)),
  ])
}
