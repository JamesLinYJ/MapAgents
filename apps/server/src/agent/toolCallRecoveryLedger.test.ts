// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用恢复账本测试
//
//   文件:       toolCallRecoveryLedger.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { ToolCallRecoveryLedger } from './toolCallRecoveryLedger.js'

describe('ToolCallRecoveryLedger', () => {
  it('removes only the call that reached a terminal state', async () => {
    const writes: Array<{ pendingToolCallIds?: string[]; recoveryStatus?: string }> = []
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async (_runId, fields) => {
        writes.push({
          ...(fields.pendingToolCallIds ? { pendingToolCallIds: [...fields.pendingToolCallIds] } : {}),
          ...(fields.recoveryStatus ? { recoveryStatus: fields.recoveryStatus } : {}),
        })
      },
    }, 'run_parallel')

    await Promise.all([
      ledger.markPending('call_a'),
      ledger.markPending('call_b'),
    ])
    await ledger.markTerminal('call_a')

    expect(ledger.snapshot()).toEqual(['call_b'])
    expect(writes.at(-1)).toEqual({
      pendingToolCallIds: ['call_b'],
      recoveryStatus: 'requires_action',
    })

    await ledger.markTerminal('call_b')
    expect(writes.at(-1)).toEqual({ pendingToolCallIds: [], recoveryStatus: 'clean' })
  })

  it('preserves pending calls restored from the durable checkpoint', async () => {
    const writes: string[][] = []
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async (_runId, fields) => {
        writes.push([...(fields.pendingToolCallIds ?? [])])
      },
    }, 'run_resume', ['call_existing', 'call_resumed'])

    await ledger.markPending('call_resumed')
    await ledger.markTerminal('call_resumed')

    expect(writes).toEqual([['call_existing']])
  })
})
