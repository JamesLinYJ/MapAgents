import PQueue from 'p-queue'
import type { AgentInputItem } from '@openai/agents'

import type { ConversationItem, RunSteeringRecord } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { makeId } from '../utils/ids.js'

type RunSteeringStore = Pick<AgentRuntimeStore,
  | 'appendItem'
  | 'consumeRunInputs'
  | 'enqueueRunInput'
  | 'getRun'
  | 'listRunInputs'
>

// RunSteeringController 是运行中用户消息的唯一状态机。
// PostgreSQL run_inputs 是排队/消费事实源；固定 entryId 和 itemId 让客户端重试与崩溃恢复幂等。
export class RunSteeringController {
  private readonly acceptingRuns = new Set<string>()
  private readonly queues = new Map<string, PQueue>()

  constructor(private readonly store: RunSteeringStore) {}

  async open(runId: string): Promise<void> {
    await this.serialized(runId, async () => {
      const run = this.store.getRun(runId)
      if (run.status !== 'running') throw new Error(`运行 '${runId}' 当前不能接收引导消息`)
      this.acceptingRuns.add(runId)
    })
  }

  async enqueue(runId: string, steeringId: string, content: string): Promise<RunSteeringRecord> {
    return this.serialized(runId, async () => {
      const normalized = content.trim()
      if (!normalized) throw new Error('引导消息不能为空')

      const existing = (await this.store.listRunInputs(runId))
        .find(record => record.steeringId === steeringId)
      if (existing) {
        if (existing.content !== normalized) throw new Error(`引导消息 '${steeringId}' 的内容与首次提交不一致`)
        await this.persistItem(existing)
        return existing
      }

      const run = this.store.getRun(runId)
      if (!this.acceptingRuns.has(runId) || run.status !== 'running') {
        throw new Error(`运行 '${runId}' 已结束接收引导消息`)
      }
      if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)

      const record = await this.store.enqueueRunInput({
        inputId: steeringId,
        entryId: makeId('entry'),
        itemId: makeId('item'),
        runId,
        content: normalized,
      })
      await this.persistItem(record)
      return record
    })
  }

  async consumePending(runId: string): Promise<AgentInputItem[]> {
    return this.serialized(runId, async () => {
      const consumed = await this.store.consumeRunInputs(runId)
      for (const record of consumed) await this.persistItem(record)
      return consumed.map(record => ({ type: 'message', role: 'user', content: record.content }))
    })
  }

  async tryClose(runId: string): Promise<boolean> {
    return this.serialized(runId, async () => {
      const hasPending = (await this.store.listRunInputs(runId))
        .some(record => record.status === 'queued')
      if (hasPending) return false
      this.acceptingRuns.delete(runId)
      return true
    })
  }

  async close(runId: string): Promise<void> {
    await this.serialized(runId, async () => {
      this.acceptingRuns.delete(runId)
    })
    const queue = this.queues.get(runId)
    if (queue) await queue.onIdle()
    if (this.queues.get(runId) === queue) this.queues.delete(runId)
  }

  private async persistItem(record: RunSteeringRecord): Promise<void> {
    const item: ConversationItem = {
      itemId: record.itemId,
      itemType: 'message',
      runId: record.runId,
      threadId: record.threadId,
      turnId: null,
      callId: null,
      role: 'user',
      body: record.content,
      name: null,
      arguments: null,
      output: null,
      isError: false,
      phase: null,
      status: record.status,
      metadata: {
        steeringId: record.steeringId,
        transcriptEntryId: record.entryId,
      },
      timestamp: record.queuedAt,
    }
    await this.store.appendItem(item)
  }

  private async serialized<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const queue = this.requireQueue(runId)
    const result = await queue.add(async () => ({ value: await work() }))
    if (!result) throw new Error(`运行 '${runId}' 的引导队列未返回结果`)
    return result.value
  }

  private requireQueue(runId: string): PQueue {
    const existing = this.queues.get(runId)
    if (existing) return existing
    const created = new PQueue({ concurrency: 1 })
    this.queues.set(runId, created)
    return created
  }
}
