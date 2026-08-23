// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用恢复账本
//
//   文件:       toolCallRecoveryLedger.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunCheckpoint } from '../schemas/types.js'

interface ToolCallRecoveryLedgerStore {
  saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
}

/**
 * 按 callId 维护恢复账本。并行调用的任意一个终态只能删除自己，
 * 不能用“某个结果已返回”推断整个 Run 已无未知副作用。
 */
export class ToolCallRecoveryLedger {
  private pending: Set<string>
  private readonly observedTerminals = new Set<string>()
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ToolCallRecoveryLedgerStore,
    private readonly runId: string,
    initialPendingToolCallIds: Iterable<string> = [],
  ) {
    this.pending = new Set(initialPendingToolCallIds)
  }

  markPending(callId: string): Promise<void> {
    return this.transition(callId, true)
  }

  markTerminal(callId: string): Promise<void> {
    return this.transition(callId, false)
  }

  observeSdkTerminal(callId: string): Promise<void> {
    if (!callId) return Promise.reject(new Error('工具调用恢复账本缺少 callId'))
    const operation = this.mutation.then(() => {
      this.observedTerminals.add(callId)
    })
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async checkpointTerminalCallIds(): Promise<string[]> {
    await this.mutation
    return [...this.observedTerminals].filter(callId => this.pending.has(callId))
  }

  // Durable SDK checkpoint 已在同一 PostgreSQL 事务中清理这些 callId。
  // 这里只同步进程内快照，不得再发起第二次 DB 写入。
  acceptCheckpointTerminals(callIds: Iterable<string>): Promise<void> {
    const terminal = new Set(callIds)
    if (!terminal.size) return Promise.resolve()
    const operation = this.mutation.then(() => {
      const next = new Set(this.pending)
      for (const callId of terminal) {
        next.delete(callId)
        this.observedTerminals.delete(callId)
      }
      this.pending = next
    })
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  snapshot(): string[] {
    return [...this.pending]
  }

  private transition(callId: string, pending: boolean): Promise<void> {
    if (!callId) return Promise.reject(new Error('工具调用恢复账本缺少 callId'))
    const operation = this.mutation.then(async () => {
      if (this.pending.has(callId) === pending) return
      const next = new Set(this.pending)
      if (pending) next.add(callId)
      else {
        next.delete(callId)
        this.observedTerminals.delete(callId)
      }
      const pendingToolCallIds = [...next]
      await this.store.saveRunCheckpoint(this.runId, {
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      })
      this.pending = next
    })
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }
}
