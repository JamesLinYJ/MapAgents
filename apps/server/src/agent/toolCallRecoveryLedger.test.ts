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
  it('accepts checkpoint terminals in memory without a second durable write', async () => {
    let writes = 0
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async () => { writes += 1 },
    }, 'run_checkpoint', ['call_done', 'call_pending'])

    await ledger.acceptCheckpointTerminals(['call_done'])

    expect(ledger.snapshot()).toEqual(['call_pending'])
    expect(writes).toBe(0)
  })

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

  it('publishes a transition in memory only after the durable write succeeds', async () => {
    let releaseWrite: (() => void) | undefined
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let finishWrite: (() => void) | undefined
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async () => {
        releaseWrite?.()
        await writeFinished
      },
    }, 'run_atomic')

    const transition = ledger.markPending('call_atomic')
    await writeStarted

    expect(ledger.snapshot()).toEqual([])

    finishWrite?.()
    await transition
    expect(ledger.snapshot()).toEqual(['call_atomic'])
  })

  it('keeps failed transitions retryable without publishing them in memory', async () => {
    const writes: string[][] = []
    let attempt = 0
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async (_runId, fields) => {
        writes.push([...(fields.pendingToolCallIds ?? [])])
        attempt += 1
        if (attempt === 1) throw new Error('injected durable write failure')
      },
    }, 'run_retry')

    await expect(ledger.markPending('call_retry')).rejects.toThrow(
      'injected durable write failure',
    )
    expect(ledger.snapshot()).toEqual([])
    await expect(ledger.markPending('call_retry')).resolves.toBeUndefined()

    expect(writes).toEqual([['call_retry'], ['call_retry']])
    expect(ledger.snapshot()).toEqual(['call_retry'])
  })

  it('does not forget a pending call when persisting its terminal state fails', async () => {
    let attempt = 0
    const ledger = new ToolCallRecoveryLedger({
      saveRunCheckpoint: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('injected terminal write failure')
      },
    }, 'run_terminal_retry', ['call_pending'])

    await expect(ledger.markTerminal('call_pending')).rejects.toThrow(
      'injected terminal write failure',
    )
    expect(ledger.snapshot()).toEqual(['call_pending'])

    await expect(ledger.markTerminal('call_pending')).resolves.toBeUndefined()
    expect(ledger.snapshot()).toEqual([])
  })
})
