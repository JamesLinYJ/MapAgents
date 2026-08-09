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

  snapshot(): string[] {
    return [...this.pending]
  }

  private transition(callId: string, pending: boolean): Promise<void> {
    if (!callId) return Promise.reject(new Error('工具调用恢复账本缺少 callId'))
    const operation = this.mutation.then(async () => {
      if (this.pending.has(callId) === pending) return
      const next = new Set(this.pending)
      if (pending) next.add(callId)
      else next.delete(callId)
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
