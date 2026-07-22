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
})
