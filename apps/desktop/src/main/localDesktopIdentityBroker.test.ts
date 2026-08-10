// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 本机托管身份 Broker 测试
//
//   文件:       localDesktopIdentityBroker.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  LocalDesktopIdentityBroker,
  type DesktopBrokerProcess,
  type DesktopBrokerProcessFactory,
} from './localDesktopIdentityBroker.js'
import type { DesktopRuntimeConfig } from './runtimeConfig.js'

const runtime: DesktopRuntimeConfig = {
  projectRoot: 'C:\\workspace\\platform',
  runtimeRoot: 'C:\\workspace\\platform\\runtime',
  supervisorTokenFile: 'C:\\workspace\\platform\\runtime\\ops\\supervisor.token',
  apiBaseUrl: 'http://127.0.0.1:8000',
  profile: 'development',
  runtimeManifestPath: null,
  autoAuth: { mode: 'local_managed' },
}

const authorization = {
  type: 'desktop.authorization' as const,
  appBaseUrl: 'http://127.0.0.1:8000',
  origin: 'http://127.0.0.1:8000',
  cookie: 'session=test',
  csrfToken: 'csrf-test',
  actor: {
    osUser: 'tester',
    hostname: 'test-host',
    processId: 42,
    keyVersion: 'v1',
  },
}

class FakeDesktopBrokerProcess extends EventEmitter {
  readonly pid = 42
  readonly stderr = new PassThrough()
  readonly postMessage = vi.fn((message: unknown) => {
    if (
      message
      && typeof message === 'object'
      && 'id' in message
      && typeof message.id === 'string'
    ) {
      queueMicrotask(() => {
        this.emit('message', { id: message.id, ok: true, result: null })
        this.emit('exit', 0)
      })
    }
  })
  readonly kill = vi.fn(() => true)
}

function createBrokerProcess(): {
  process: FakeDesktopBrokerProcess
  factory: DesktopBrokerProcessFactory
  fork: ReturnType<typeof vi.fn>
} {
  const process = new FakeDesktopBrokerProcess()
  const fork = vi.fn(() => process as DesktopBrokerProcess)
  return {
    process,
    fork,
    factory: { fork },
  }
}

describe('LocalDesktopIdentityBroker', () => {
  it('通过结构化 Utility Process 消息取得授权', async () => {
    const harness = createBrokerProcess()
    const broker = new LocalDesktopIdentityBroker(runtime, harness.factory)
    const opening = broker.open()

    harness.process.emit('message', authorization)

    await expect(opening).resolves.toEqual(authorization)
    expect(harness.fork).toHaveBeenCalledWith(
      expect.stringMatching(/localOperationsBrokerEntry\.js$/u),
      ['desktop'],
      expect.objectContaining({
        cwd: runtime.projectRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    )
  })

  it('只把受保护的本机服务环境路径传给 Broker', async () => {
    const harness = createBrokerProcess()
    const environmentFile = '/home/tester/.config/geo-agent-platform/runtime.env'
    const broker = new LocalDesktopIdentityBroker(runtime, harness.factory, {
      serviceEnvironmentFile: environmentFile,
    })
    const opening = broker.open()
    harness.process.emit('message', authorization)
    await opening

    expect(harness.fork).toHaveBeenCalledWith(
      expect.any(String),
      ['desktop'],
      expect.objectContaining({
        env: expect.objectContaining({
          GEO_AGENT_PLATFORM_SERVICE_ENV_FILE: environmentFile,
        }),
      }),
    )
  })

  it('关闭时发送有 schema 的控制消息并等待 Broker 确认', async () => {
    const harness = createBrokerProcess()
    const broker = new LocalDesktopIdentityBroker(runtime, harness.factory)
    const opening = broker.open()
    harness.process.emit('message', authorization)
    await opening

    await expect(broker.close()).resolves.toBeUndefined()
    expect(harness.process.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      operation: 'desktop.close',
      outcome: 'allowed',
    }))
  })

  it('拒绝结构不匹配的 Broker 消息并结束子进程', async () => {
    const harness = createBrokerProcess()
    const broker = new LocalDesktopIdentityBroker(runtime, harness.factory)
    const opening = broker.open()

    harness.process.emit('message', 'not-a-structured-message')

    await expect(opening).rejects.toThrow(/无效消息/u)
    expect(harness.process.kill).toHaveBeenCalledOnce()
  })
})
