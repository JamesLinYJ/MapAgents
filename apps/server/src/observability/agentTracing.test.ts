// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 本地追踪处理器测试
//
//   文件:       agentTracing.test.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Span, Trace } from '@openai/agents'
import { describe, expect, it } from 'vitest'

import type { RunEvent } from '../schemas/types.js'
import { RunEventSink } from '../agent/turnRunner.js'
import { LocalAgentTracing } from './agentTracing.js'

describe('LocalAgentTracing', () => {
  it('routes sanitized SDK lifecycle records to the owning run only', async () => {
    const tracing = new LocalAgentTracing()
    tracing.install()
    const events: RunEvent[] = []
    const sink = new RunEventSink(event => { events.push(event) }, 'run_trace', 'thread_trace')
    const detach = tracing.attachRun('run_trace', sink)
    try {
      const trace = new Trace({
        traceId: 'trace_0123456789abcdef0123456789abcdef',
        name: 'GeoForge Agent Workflow',
        groupId: 'thread_trace',
        metadata: { runId: 'run_trace', threadId: 'thread_trace' },
      }, tracing)
      const span = new Span({
        traceId: trace.traceId,
        spanId: 'span_0123456789abcdef0123456789abcdef',
        parentId: undefined,
        traceMetadata: { runId: 'run_trace', threadId: 'thread_trace' },
        startedAt: '2026-07-21T00:00:00.000Z',
        endedAt: '2026-07-21T00:00:00.125Z',
        data: {
          type: 'function',
          name: 'query_layer',
          input: 'SECRET_INPUT_MUST_NOT_BE_PERSISTED',
          output: 'SECRET_OUTPUT_MUST_NOT_BE_PERSISTED',
        },
      }, tracing)

      await tracing.onTraceStart(trace)
      await tracing.onSpanEnd(span)
      await tracing.onTraceEnd(trace)
      await tracing.forceFlush()

      expect(events.map(event => event.type)).toEqual([
        'trace.recorded',
        'trace.recorded',
        'trace.recorded',
      ])
      expect(events[1]).toMatchObject({
        message: 'SDK 工具 Span完成',
        payload: {
          diagnostic: true,
          phase: 'span_end',
          spanType: 'function',
          spanName: 'query_layer',
          durationMs: 125,
          failed: false,
        },
      })
      expect(JSON.stringify(events)).not.toContain('SECRET_INPUT_MUST_NOT_BE_PERSISTED')
      expect(JSON.stringify(events)).not.toContain('SECRET_OUTPUT_MUST_NOT_BE_PERSISTED')
    } finally {
      detach()
      await tracing.shutdown()
    }
  })

  it('ignores traces that do not declare a registered GeoForge runId', async () => {
    const tracing = new LocalAgentTracing()
    tracing.install()
    const events: RunEvent[] = []
    const sink = new RunEventSink(event => { events.push(event) }, 'run_trace', 'thread_trace')
    const detach = tracing.attachRun('run_trace', sink)
    try {
      const unrelated = new Trace({ name: 'Unrelated trace', metadata: { runId: 'run_other' } }, tracing)
      await tracing.onTraceStart(unrelated)
      await tracing.forceFlush()
      expect(events).toEqual([])
    } finally {
      detach()
      await tracing.shutdown()
    }
  })
})
