import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { PersistenceFacadeTestHarness } from '../../test-support/persistenceFacadeHarness.js'
import { RunSteeringController } from './runSteeringController.js'

describe('RunSteeringController', () => {
  it('queues idempotently, consumes in order, and rejects new input after close', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geoforge-steering-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行中引导')
      const run = await store.createRun(session.id, '先分析数据', { threadId: thread.id })
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)

      await controller.open(run.id)
      const first = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      const retry = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      expect(retry).toEqual(first)
      expect((await store.listRunInputs(run.id))).toHaveLength(1)

      const consumed = await controller.consumePending(run.id)
      expect(consumed).toEqual([{
        type: 'message',
        role: 'user',
        content: '重点检查最近三十分钟',
      }])
      expect((await store.listRunInputs(run.id))[0]?.status).toBe('consumed')
      expect((await store.activeTranscript(thread.id)).at(-1)?.payload.content).toBe('重点检查最近三十分钟')
      const steeringItem = (await store.listItems(run.id)).find(item => item.itemId === first.itemId)
      expect(steeringItem?.metadata).toMatchObject({
        steeringId: first.steeringId,
        transcriptEntryId: first.entryId,
      })
      expect(steeringItem?.metadata).not.toHaveProperty('steeringEntryId')

      await controller.close(run.id)
      await expect(controller.enqueue(run.id, 'steer_2', '再检查空间范围'))
        .rejects.toThrow('已结束接收引导消息')
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
