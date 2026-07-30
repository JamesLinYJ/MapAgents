// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Supervisor 网关测试
//
//   文件:       supervisorGateway.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  OperationsLogEntry,
  OperationsLogQuery,
} from '@geo-agent-platform/shared-types/operations'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopRuntimeConfig } from './runtimeConfig.js'
import { DesktopSupervisorGateway } from './supervisorGateway.js'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  )
})

describe('DesktopSupervisorGateway logs', () => {
  it('does not expose the local supervisor token path when the runtime is absent', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-status-'))
    cleanupDirectories.push(projectRoot)
    const runtimeRoot = path.join(projectRoot, 'runtime')
    const gateway = new DesktopSupervisorGateway(runtimeConfig(projectRoot, runtimeRoot))

    try {
      const response = await gateway.handle({
        version: 1,
        requestId: '019fa8d2-d331-7c48-a667-68383b815be6',
        command: 'status',
        payload: {},
      })

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'supervisor_unavailable',
          message: '本机监督器尚未初始化或运行文件缺失，请从本机运维台启动后台服务。',
        },
      })
      expect(JSON.stringify(response)).not.toContain(runtimeRoot)
    } finally {
      gateway.close()
    }
  })

  it('keeps local Main logs readable when the Supervisor is unavailable', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-logs-'))
    cleanupDirectories.push(projectRoot)
    const runtimeRoot = path.join(projectRoot, 'runtime')
    const localEntry: OperationsLogEntry = {
      sequence: 1_000_000_000,
      serviceId: null,
      component: 'desktop',
      processId: 42,
      stream: 'supervisor',
      level: 'info',
      message: 'desktop_ready',
      createdAt: '2026-07-29T09:00:00.000Z',
    }
    const read = vi.fn(async (_query: OperationsLogQuery) => [localEntry])
    const gateway = new DesktopSupervisorGateway(runtimeConfig(projectRoot, runtimeRoot), { read })

    try {
      const response = await gateway.logs(logQuery())

      expect(read).toHaveBeenCalledOnce()
      expect(response).toEqual([
        localEntry,
        expect.objectContaining({
          component: 'desktop',
          level: 'error',
          message: expect.stringContaining('Supervisor 日志不可用'),
        }),
      ])
    } finally {
      gateway.close()
    }
  })

  it('does not silently substitute local logs for a service-only query', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-logs-'))
    cleanupDirectories.push(projectRoot)
    const runtimeRoot = path.join(projectRoot, 'runtime')
    const gateway = new DesktopSupervisorGateway(runtimeConfig(projectRoot, runtimeRoot), {
      read: async () => [],
    })

    try {
      await expect(gateway.logs({
        ...logQuery(),
        includeSupervisor: false,
      })).rejects.toThrow('本机监督器尚未初始化或运行文件缺失')
    } finally {
      gateway.close()
    }
  })
})

function runtimeConfig(projectRoot: string, runtimeRoot: string): DesktopRuntimeConfig {
  return {
    projectRoot,
    runtimeRoot,
    supervisorTokenFile: path.join(runtimeRoot, 'ops', 'missing-supervisor.token'),
    runtimeManifestPath: null,
    apiBaseUrl: 'http://127.0.0.1:8000',
    profile: 'development',
    autoAuth: null,
  }
}

function logQuery(): OperationsLogQuery {
  return {
    services: ['infra', 'worker', 'api'],
    levels: [],
    streams: [],
    search: '',
    includeSupervisor: true,
    afterSequence: null,
    tail: 100,
  }
}
