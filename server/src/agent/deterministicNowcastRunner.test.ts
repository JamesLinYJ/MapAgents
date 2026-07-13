import { describe, expect, it, vi } from 'vitest'

import type { ItemSink } from '../conversation/itemSink.js'
import type { DeterministicNowcastStore } from '../store/runtimePorts.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RunEventSink } from './turnRunner.js'
import { runDeterministicNowcast } from './deterministicNowcastRunner.js'

describe('runDeterministicNowcast', () => {
  it('does not start any tool after the run is cancelled', async () => {
    const controller = new AbortController()
    controller.abort('cancelled by user')
    const executeDirect = vi.fn()

    await expect(runDeterministicNowcast({
      store: {} as DeterministicNowcastStore,
      coordinator: { executeDirect } as unknown as ToolExecutionCoordinator,
      eventSink: {} as RunEventSink,
      itemSink: {} as ItemSink,
      runId: 'run_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      query: '未来三小时会下雨吗',
      signal: controller.signal,
    })).rejects.toBe('cancelled by user')

    expect(executeDirect).not.toHaveBeenCalled()
  })
})
