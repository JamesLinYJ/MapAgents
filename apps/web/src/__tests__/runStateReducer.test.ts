// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态归约测试
//
//   文件:       runStateReducer.test.ts
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  type AnalysisRun,
} from '@geo-agent-platform/shared-types'

import { runReducer, type RunState } from '../features/runs/useRunState'

describe('runReducer', () => {
  it('切换同一 thread 的新 run 时清空上一 run 的流式投影', () => {
    const previous = makeRun('run_previous', 'thread_1')
    const next = makeRun('run_next', 'thread_1')
    const event = runEventSchema.parse({
      eventId: 'event_previous',
      runId: previous.id,
      threadId: previous.threadId,
      type: 'step.started',
      message: '旧事件',
      timestamp: previous.createdAt,
    })
    const item = conversationItemSchema.parse({
      itemId: 'item_previous',
      itemType: 'message',
      runId: previous.id,
      threadId: previous.threadId,
      role: 'assistant',
      body: '旧消息',
      timestamp: previous.createdAt,
    })
    const state: RunState = {
      run: previous,
      agentState: previous.state,
      events: [event],
      items: [item],
      artifacts: [],
      isSubmitting: false,
      seenEventIds: new Set([event.eventId]),
      placeResolution: { status: 'resolved', selected: { latitude: 30, longitude: 120 } },
    }

    const result = runReducer(state, {
      type: 'SET_RUN',
      run: next,
      agentState: next.state,
      artifacts: [],
    })

    expect(result.run?.id).toBe('run_next')
    expect(result.items).toEqual([])
    expect(result.events).toEqual([])
    expect(result.seenEventIds.size).toBe(0)
    expect(result.placeResolution).toBeNull()
  })

  it('同一 run 的增量快照保留已经到达的流式内容', () => {
    const run = makeRun('run_1', 'thread_1')
    const state: RunState = {
      run,
      agentState: run.state,
      events: [],
      items: [],
      artifacts: [],
      isSubmitting: true,
      seenEventIds: new Set(),
    }

    const result = runReducer(state, {
      type: 'SET_RUN',
      run: { ...run, status: 'completed' },
      agentState: run.state,
      artifacts: [],
    })

    expect(result.isSubmitting).toBe(false)
    expect(result.items).toBe(state.items)
    expect(result.events).toBe(state.events)
  })
})

function makeRun(runId: string, threadId: string): AnalysisRun {
  const now = '2026-07-10T00:00:00.000Z'
  return analysisRunSchema.parse({
    id: runId,
    threadId,
    sessionId: 'session_1',
    visibility: 'workspace',
    userQuery: '测试',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    state: {
      sessionId: 'session_1',
      threadId,
      userQuery: '测试',
    },
  })
}
