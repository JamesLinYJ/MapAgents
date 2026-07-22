// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机进程监督运行时测试
//
//   文件:       supervisor.test.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationsLogBuffer } from './logBuffer.js'
import { resolveOperationsPaths } from './paths.js'
import { OperationsSupervisor } from './supervisor.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('OperationsSupervisor operations', () => {
  it('deduplicates an in-flight operationId instead of replaying the write', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geoforge-supervisor-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const supervisor = new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {},
      logBuffer: new OperationsLogBuffer([]),
      logger: pino({ enabled: false }),
    })
    const observed = vi.fn()
    const unsubscribe = supervisor.onOperation(observed)
    const operation = {
      action: 'stop' as const,
      target: 'all' as const,
      operationId: 'same-operation-id',
      actor: { osUser: 'tester', hostname: 'test-host', processId: 42 },
    }

    try {
      const first = supervisor.execute(operation)
      const duplicate = supervisor.execute(operation)
      expect(duplicate).toBe(first)
      await expect(Promise.all([first, duplicate])).resolves.toMatchObject([
        { operationId: operation.operationId, outcome: 'succeeded' },
        { operationId: operation.operationId, outcome: 'succeeded' },
      ])
      expect(observed).toHaveBeenCalledOnce()
      await expect(supervisor.execute(operation)).resolves.toMatchObject({
        operationId: operation.operationId,
        outcome: 'succeeded',
      })
      expect(observed).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
      await supervisor.close()
    }
  })

  it('ignores a stale health probe after the supervised command closes', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        stopping: boolean
        state: string
      }
      monitorHealth(record: unknown): Promise<void>
      probe(record: unknown): Promise<{ ok: boolean; message: string }>
      runShutdownHook(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = { pid: 42, process: {} }
    let releaseProbe: ((value: { ok: boolean; message: string }) => void) | undefined
    harness.probe = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => { releaseProbe = resolve }))
    harness.runShutdownHook = vi.fn(async () => undefined)

    try {
      const monitoring = harness.monitorHealth(record)
      await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'))
      record.command = null
      record.state = 'restart_wait'
      releaseProbe?.({ ok: false, message: '旧探针失败' })
      await expect(monitoring).resolves.toBeUndefined()
      expect(record.state).toBe('restart_wait')
    } finally {
      await supervisor.close()
    }
  })

  it('runs the fixed shutdown hook when an active service lost its command handle', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        state: string
        healthMessage: string
      }
      runShutdownHook(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = null
    record.state = 'healthy'
    harness.runShutdownHook = vi.fn(async () => undefined)

    try {
      await expect(supervisor.execute({
        action: 'shutdown',
        target: 'all',
        operationId: 'shutdown-without-infra-command',
        actor: { osUser: 'tester', hostname: 'test-host', processId: 42 },
      })).resolves.toMatchObject({ outcome: 'succeeded' })
      expect(harness.runShutdownHook).toHaveBeenCalledOnce()
      expect(record.state).toBe('stopped')
      expect(record.healthMessage).toBe('已停止')
    } finally {
      await supervisor.close()
    }
  })

  it('serializes slow health probes instead of accumulating overlapping checks', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        stopping: boolean
        healthProbeInFlight: boolean
      }
      monitorHealth(record: unknown): Promise<void>
      probe(record: unknown): Promise<{ ok: boolean; message: string }>
      runShutdownHook(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = { pid: 42, process: {} }
    const pending: Array<(value: { ok: boolean; message: string }) => void> = []
    harness.probe = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => pending.push(resolve)))
    harness.runShutdownHook = vi.fn(async () => undefined)

    try {
      const first = harness.monitorHealth(record)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      await expect(harness.monitorHealth(record)).resolves.toBeUndefined()
      expect(harness.probe).toHaveBeenCalledOnce()
      expect(record.healthProbeInFlight).toBe(true)
      pending[0]?.({ ok: true, message: '健康' })
      await first
      expect(record.healthProbeInFlight).toBe(false)

      const next = harness.monitorHealth(record)
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1]?.({ ok: true, message: '健康' })
      await next
      expect(harness.probe).toHaveBeenCalledTimes(2)
    } finally {
      record.command = null
      await supervisor.close()
    }
  })
})

async function createSupervisor(): Promise<{ supervisor: OperationsSupervisor }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geoforge-supervisor-'))
  cleanupPaths.push(projectRoot)
  const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
  return {
    supervisor: new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {},
      logBuffer: new OperationsLogBuffer([]),
      logger: pino({ enabled: false }),
    }),
  }
}
