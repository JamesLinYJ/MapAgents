// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行实时传输投影测试
//
//   文件:       runTransportProjection.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { gzipSync } from 'node:zlib'

import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import {
  projectConversationItemForTransport,
  projectRunEventForTransport,
  projectRunSnapshotForTransport,
} from './runTransportProjection.js'

describe('run realtime transport projection', () => {
  it('keeps canonical large values server-side and produces a bounded client snapshot', () => {
    const coordinates = Array.from({ length: 14_000 }, (_, index) => [
      118 + index / 100_003,
      29 + index / 200_003,
    ])
    const largeValue = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { name: '杭州短临边界' },
      }],
    }
    const run = analysisRunSchema.parse({
      id: 'run_projection',
      sessionId: 'session_projection',
      threadId: 'thread_projection',
      visibility: 'workspace',
      userQuery: '分析连续 NC 文件',
      status: 'completed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
      state: {
        sessionId: 'session_projection',
        threadId: 'thread_projection',
        userQuery: '分析连续 NC 文件',
        toolValueRefs: [{
          refId: 'ref_large_geometry',
          kind: 'feature_collection',
          label: '完整杭州边界',
          value: largeValue,
        }],
        toolResults: [{
          stepId: 'step_1',
          tool: 'query_layer',
          status: 'completed',
          message: '已查询图层',
          valueRefs: [{
            refId: 'ref_large_geometry',
            kind: 'feature_collection',
            label: '完整杭州边界',
            value: largeValue,
          }],
        }],
      },
    })
    const output = conversationItemSchema.parse({
      itemId: 'item_output',
      itemType: 'function_call_output',
      runId: run.id,
      threadId: run.threadId,
      callId: 'call_1',
      output: JSON.stringify({
        message: '已查询杭州图层',
        payload: largeValue,
        resultId: 'result_query',
      }),
      status: 'completed',
      timestamp: new Date(1).toISOString(),
    })
    const answer = conversationItemSchema.parse({
      itemId: 'item_answer',
      itemType: 'message',
      runId: run.id,
      threadId: run.threadId,
      role: 'assistant',
      body: '杭州未来三小时累计雨量约 7.4 mm。',
      status: 'completed',
      timestamp: new Date(2).toISOString(),
    })
    const event = runEventSchema.parse({
      eventId: 'event_tool',
      runId: run.id,
      threadId: run.threadId,
      type: 'tool.completed',
      message: '图层查询完成',
      timestamp: new Date(1).toISOString(),
      payload: { toolName: 'query_layer', result: largeValue },
    })

    const snapshot = runSnapshotSchema.parse({ run, items: [output, answer], events: [event] })
    const projected = projectRunSnapshotForTransport(snapshot)
    const wire = JSON.stringify({
      type: 'run.snapshot',
      id: null,
      payload: { data: projected },
    })

    expect(run.state.toolValueRefs[0]?.value).toEqual(largeValue)
    expect(projected.run.state.toolValueRefs[0]?.value).toBeNull()
    expect(projected.items.at(-1)?.body).toBe('杭州未来三小时累计雨量约 7.4 mm。')
    expect(projected.items[0]?.output).toContain('bounded_json')
    expect(projected.events[0]?.payload.transportProjection).toBe('bounded_run_event')
    expect(gzipSync(wire).byteLength).toBeLessThan(48 * 1024)
  })

  it('bounds individual incremental tool items and events', () => {
    const raw = JSON.stringify({ values: Array.from({ length: 50_000 }, (_, index) => index / 7) })
    const item = conversationItemSchema.parse({
      itemId: 'item_large',
      itemType: 'function_call_output',
      runId: 'run_1',
      output: raw,
      timestamp: new Date(0).toISOString(),
    })
    const event = runEventSchema.parse({
      eventId: 'event_large',
      runId: 'run_1',
      type: 'tool.completed',
      message: '完成',
      timestamp: new Date(0).toISOString(),
      payload: { raw },
    })

    expect(Buffer.byteLength(JSON.stringify(projectConversationItemForTransport(item)), 'utf8'))
      .toBeLessThan(24 * 1024)
    expect(Buffer.byteLength(JSON.stringify(projectRunEventForTransport(event)), 'utf8'))
      .toBeLessThan(16 * 1024)
  })

  it('charges string budgets by actual content instead of the per-field cap', () => {
    const artifact = {
      artifactId: 'artifact_preview',
      artifactType: 'raster_png',
      name: '风险图预览',
      uri: '/api/v1/results/artifact_preview',
      display: {
        primarySurface: 'mini_app',
        surfaces: ['mini_app', 'download'],
        map: null,
      },
    }
    const item = conversationItemSchema.parse({
      itemId: 'item_artifact',
      itemType: 'function_call_output',
      runId: 'run_1',
      output: '{}',
      metadata: { artifacts: [artifact] },
      timestamp: new Date(0).toISOString(),
    })

    expect(projectConversationItemForTransport(item).metadata).toMatchObject({
      artifacts: [artifact],
    })
  })
})
