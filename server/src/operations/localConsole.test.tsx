// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 中文本地运维台测试
//
//   文件:       localConsole.test.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
//
//   维护记录 (2026-07-22):
//     作者: OpenAI Codex
//     说明: 覆盖响应式中文 TUI、数据库隔离与分离行为。
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'

import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import type { OperationsSnapshot } from '@geo-agent-platform/shared-types/operations'
import { ThemeProvider } from '@inkjs/ui'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalConsoleApp } from './localConsole.js'
import { geoForgeConsoleTheme } from './localConsoleTheme.js'
import type { LocalConsoleOptions } from './localConsoleTypes.js'

afterEach(() => cleanup())

describe('LocalConsoleApp', () => {
  it.each([
    [80, 'GeoForge 本地运维台'],
    [100, '杭州基础设施'],
    [140, '服务检查器'],
    [180, '实时日志'],
  ])('renders a stable Chinese layout at %i columns', async (columns, expected) => {
    const client = createClient()
    const instance = renderConsole(client)
    resize(instance.stdout, columns, 36)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain(expected))
  })

  it('shows a non-broken size guard below 80x24', async () => {
    const instance = renderConsole(createClient())
    resize(instance.stdout, 79, 23)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('终端尺寸不足'))
    expect(instance.lastFrame()).toContain('至少需要 80×24')
  })

  it('keeps service controls visible when the account database is unavailable', async () => {
    const client = createClient()
    const options = createOptions(client, vi.fn().mockRejectedValue(new Error('database offline')))
    const instance = render(
      <ThemeProvider theme={geoForgeConsoleTheme}><LocalConsoleApp options={options} /></ThemeProvider>,
    )
    resize(instance.stdout, 140, 36)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('杭州基础设施'))

    instance.stdin.write('3')

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('账户数据不可用：database offline'))
    expect(instance.lastFrame()).toContain('GeoForge 本地运维台')
  })

  it('q detaches the client without issuing a shutdown operation', async () => {
    const client = createClient()
    const instance = renderConsole(client)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('杭州基础设施'))

    instance.stdin.write('q')

    await vi.waitFor(() => expect(client.close).toHaveBeenCalled())
    expect(client.shutdown).not.toHaveBeenCalled()
  })
})

function renderConsole(client: OperationsClient) {
  return render(
    <ThemeProvider theme={geoForgeConsoleTheme}>
      <LocalConsoleApp options={createOptions(client, vi.fn())} />
    </ThemeProvider>,
  )
}

function createOptions(client: OperationsClient, openDataPlane: LocalConsoleOptions['openDataPlane']): LocalConsoleOptions {
  return {
    connectSupervisor: vi.fn().mockResolvedValue(client),
    openDataPlane,
    minPasswordLength: 12,
  }
}

function createClient(): OperationsClient {
  const events = new EventEmitter()
  const client = {
    status: vi.fn().mockResolvedValue(snapshot),
    logs: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    operate: vi.fn(),
    shutdown: vi.fn(),
    close: vi.fn(() => events.emit('disconnected', new Error('client detached'))),
    onEvent: vi.fn((listener: (...args: unknown[]) => void) => {
      events.on('event', listener)
      return () => events.off('event', listener)
    }),
    onDisconnected: vi.fn((listener: (...args: unknown[]) => void) => {
      events.on('disconnected', listener)
      return () => events.off('disconnected', listener)
    }),
  }
  return client as unknown as OperationsClient
}

function resize(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  stdout.emit('resize')
}

const unavailable = { value: null, unavailableReason: '尚未采集' } as const
const snapshot: OperationsSnapshot = {
  sequence: 1,
  host: {
    hostname: '杭州开发机',
    platform: 'win32',
    release: 'test',
    profile: 'development',
    supervisorPid: 42,
    supervisorStartedAt: '2026-07-22T00:00:00.000Z',
    cpuPercent: { value: 12.5 },
    memoryUsedBytes: { value: 4 * 1024 ** 3 },
    memoryTotalBytes: { value: 16 * 1024 ** 3 },
    runtimeDiskUsedBytes: { value: 20 * 1024 ** 3 },
    runtimeDiskTotalBytes: { value: 100 * 1024 ** 3 },
    sampledAt: '2026-07-22T00:00:00.000Z',
  },
  services: [
    service('infra', '杭州基础设施', []),
    service('worker', '科学计算', ['infra']),
    service('api', '平台 API', ['infra', 'worker']),
    service('web', 'Web 工作台', ['api']),
  ],
}

function service(
  serviceId: 'infra' | 'worker' | 'api' | 'web',
  displayName: string,
  blockedBy: Array<'infra' | 'worker' | 'api' | 'web'>,
): OperationsSnapshot['services'][number] {
  return {
    serviceId,
    displayName,
    description: `${displayName}测试服务`,
    state: blockedBy.length ? 'stopped' : 'healthy',
    healthMessage: blockedBy.length ? '未启动' : '健康检查通过',
    pid: blockedBy.length ? null : 1234,
    cpuPercent: blockedBy.length ? unavailable : { value: 18.2 },
    memoryBytes: blockedBy.length ? unavailable : { value: 512 * 1024 ** 2 },
    startedAt: blockedBy.length ? null : '2026-07-22T00:00:00.000Z',
    uptimeSeconds: blockedBy.length ? null : 360,
    restartCount: 0,
    lastExitCode: null,
    blockedBy,
    containers: [],
  }
}
