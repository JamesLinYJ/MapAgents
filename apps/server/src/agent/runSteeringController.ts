// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行引导控制器
//
//   文件:       runSteeringController.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import PQueue from 'p-queue'
import type { AgentInputItem } from '@openai/agents'

import type { AgentState, ConversationItem, RunGoal, RunSteeringRecord } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { makeId } from '../utils/ids.js'
import { advanceAgentWorkflowObjectiveRevision } from './agentWorkflowState.js'

type RunSteeringStore = Pick<AgentRuntimeStore,
  | 'appendItem'
  | 'consumeRunInputs'
  | 'enqueueRunInput'
  | 'getRun'
  | 'listRunInputs'
  | 'mutateRunState'
>

interface ObjectiveRevisionSnapshot {
  records: RunSteeringRecord[]
  state: AgentState
}

export interface ModelInputRevisionSnapshot {
  objectiveRevision: number
  state: AgentState | null
}

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
      await this.synchronizeObjectiveRevision(runId)
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
        await this.synchronizeObjectiveRevision(runId)
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
      await this.synchronizeObjectiveRevision(runId)
      await this.persistItem(record)
      return record
    })
  }

  async consumePending(runId: string): Promise<AgentInputItem[]> {
    return (await this.consumePendingWithRevision(runId)).items
  }

  async consumePendingWithRevision(runId: string): Promise<{
    items: AgentInputItem[]
    objectiveRevision: number
  }> {
    return this.serialized(runId, async () => {
      const consumed = await this.store.consumeRunInputs(runId)
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      for (const record of consumed) await this.persistItem(record)
      return {
        items: consumed.map(record => ({ type: 'message', role: 'user', content: record.content })),
        objectiveRevision: consumedObjectiveRevision(snapshot.records),
      }
    })
  }

  // 当前模型候选只覆盖已经消费的输入。queued 输入计入 objective revision，
  // 但不能绑定到尚未看见该输入的模型输出。
  async consumedObjectiveRevision(runId: string): Promise<number> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      return consumedObjectiveRevision(snapshot.records)
    })
  }

  // 热路径一次读取即可同时得到模型已消费 revision 与其一致状态，避免每个
  // 模型候选为 revision/state 分别查询 durable run_inputs。
  async modelInputRevisionSnapshot(runId: string): Promise<ModelInputRevisionSnapshot> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      const objectiveRevision = consumedObjectiveRevision(snapshot.records)
      return {
        objectiveRevision,
        state: revisionMatches(snapshot, objectiveRevision)
          ? structuredClone(snapshot.state)
          : null,
      }
    })
  }

  // 在 per-run steering 顺序内取得与 revision 一致的只读状态。调用方可在
  // Judge 之外执行昂贵工作；提交时仍必须再次走 commitRevision/terminal claim。
  async stateForRevision(runId: string, objectiveRevision: number): Promise<AgentState | null> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      return revisionMatches(snapshot, objectiveRevision)
        ? structuredClone(snapshot.state)
        : null
    })
  }

  // 非终态 revision 提交与 steering 入队共享同一线性化队列。这样 Judge
  // 返回后不能把旧 verdict 写进新 objective revision。
  async commitRevision(
    runId: string,
    objectiveRevision: number,
    commit: (state: AgentState) => Promise<void>,
  ): Promise<boolean> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      if (!revisionMatches(snapshot, objectiveRevision)) return false
      await commit(structuredClone(snapshot.state))
      return true
    })
  }

  // terminal claim 先核对 durable objective revision，再关闭接收窗口。成功后
  // 后续 enqueue 会被拒绝，终态持久化/flush 期间不会再出现未绑定的新输入。
  async tryClaimTerminal(runId: string, objectiveRevision: number): Promise<boolean> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      if (!revisionMatches(snapshot, objectiveRevision)) return false
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

  private async synchronizeObjectiveRevision(runId: string): Promise<ObjectiveRevisionSnapshot> {
    const records = await this.store.listRunInputs(runId)
    const durableRevision = 1 + records.length
    const current = this.store.getRun(runId).state
    if (current.objectiveRevision > durableRevision) {
      throw new Error(
        `运行 '${runId}' objective revision ${current.objectiveRevision} 超过 durable input revision ${durableRevision}`,
      )
    }
    if (current.objectiveRevision === durableRevision) return { records, state: current }

    const updated = await this.store.mutateRunState(runId, state => ({
      objectiveRevision: durableRevision,
      goal: advanceGoalObjectiveRevision(state.goal, durableRevision),
      agentWorkflow: state.agentWorkflow
        ? advanceAgentWorkflowObjectiveRevision(state.agentWorkflow, durableRevision)
        : null,
    }))
    return { records, state: updated.state }
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

function consumedObjectiveRevision(records: RunSteeringRecord[]): number {
  return 1 + records.filter(record => record.status === 'consumed').length
}

function revisionMatches(snapshot: ObjectiveRevisionSnapshot, expected: number): boolean {
  return snapshot.state.objectiveRevision === expected
    && 1 + snapshot.records.length === expected
    && consumedObjectiveRevision(snapshot.records) === expected
}

function advanceGoalObjectiveRevision(goal: RunGoal | null, objectiveRevision: number): RunGoal | null {
  if (!goal || objectiveRevision <= goal.objectiveRevision) return goal
  const updatedAt = new Date().toISOString()
  return {
    ...goal,
    objectiveRevision,
    status: 'active',
    recheckCount: 0,
    lastVerdict: null,
    failureReason: null,
    updatedAt,
    completedAt: null,
  }
}
