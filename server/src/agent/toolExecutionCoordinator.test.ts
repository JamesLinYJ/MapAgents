// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行协调器测试
//
//   文件:       toolExecutionCoordinator.test.ts
//
//   日期:       2026年06月24日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { ItemSink } from '../conversation/itemSink.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolProvider, ToolResult } from '../framework/types.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import { formatToolResultForModel, ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import { RunEventSink } from './turnRunner.js'

describe('formatToolResultForModel', () => {
  it('keeps valueRefs visible while summarizing oversized payloads', () => {
    const result: ToolResult = {
      message: 'create_nowcast_sequence 执行完成',
      payload: {
        datasets: Array.from({ length: 60 }, (_, index) => ({
          filename: `lead_${String(index).padStart(3, '0')}.nc`,
          metadata: {
            variables: Array.from({ length: 20 }, (_item, variableIndex) => ({
              name: `QPF_${variableIndex}`,
              bounds: [115.5, 27, 124.5, 32],
            })),
          },
        })),
      },
      warnings: [],
      resultId: 'result_sequence',
      source: 'test',
      valueRefs: [
        { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', value: {} },
        { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', value: {} },
      ],
    }

    const formatted = JSON.parse(formatToolResultForModel(result, 1200)) as Record<string, unknown>

    expect(formatted.valueRefs).toEqual([
      { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', unit: null },
      { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', unit: null },
    ])
    expect(formatted.payloadSummary).toMatchObject({
      datasets: {
        type: 'array',
        length: 60,
      },
    })
    expect(JSON.stringify(formatted)).not.toContain('lead_059.nc')
  })
})

describe('ToolExecutionCoordinator', () => {
  it('persists the Chinese tool label with transcript and conversation items', async () => {
    const transcriptWrites: Array<Record<string, unknown>> = []
    const conversationItems: Array<{ metadata: Record<string, unknown> }> = []
    const store = {
      activeTranscript: vi.fn(async () => []),
      appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
        transcriptWrites.push(input)
        return {
          schemaVersion: 2,
          seq: transcriptWrites.length,
          entryId: `entry_${transcriptWrites.length}`,
          parentEntryId: null,
          logicalParentEntryId: null,
          threadId: 'thread_1',
          runId: 'run_1',
          turnId: 'turn_1',
          kind: input.kind,
          timestamp: '2026-06-24T00:00:00.000Z',
          payload: input.payload ?? {},
        }
      }),
      saveRunCheckpoint: vi.fn(async () => undefined),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const itemSink = new ItemSink(
      item => { conversationItems.push(item) },
      'run_1',
      'thread_1',
    )
    const coordinator = new ToolExecutionCoordinator({
      store,
      registry,
      adapter: null,
      runId: 'run_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink,
      valueState: new Map(),
      signal: new AbortController().signal,
    })

    await coordinator.prepare('inspect_dataset', { datasetId: 'dataset_1' }, 'call_1')
    await itemSink.flush()

    expect(transcriptWrites[0]).toMatchObject({
      kind: 'tool_call',
      payload: { name: 'inspect_dataset', label: '检查数据集' },
    })
    expect(conversationItems[0]?.metadata).toMatchObject({ toolLabel: '检查数据集' })
  })

  it('persists a failed platform tool result immediately with its real label', async () => {
    const transcriptWrites: Array<Record<string, unknown>> = []
    let warnings: string[] = []
    let errors: string[] = []
    let failedTool: string | null = null
    const store = {
      runtimeRoot: 'C:/runtime',
      activeTranscript: vi.fn(async () => []),
      appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
        transcriptWrites.push(input)
        return { entryId: `entry_${transcriptWrites.length}` }
      }),
      saveRunCheckpoint: vi.fn(async () => undefined),
      getRun: vi.fn(() => ({
        workspaceId: 'workspace_1',
        state: { planMode: false, agentWorkflow: null, todos: [], warnings, errors },
      })),
      updateRunState: vi.fn(async (_runId: string, updates: {
        warnings?: string[]
        errors?: string[]
        failedTool?: string | null
      }) => {
        warnings = updates.warnings ?? warnings
        errors = updates.errors ?? errors
        failedTool = updates.failedTool ?? failedTool
        return undefined
      }),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    const provider = testProvider()
    const failingTool = provider.tools()[0]
    if (!failingTool) throw new Error('测试工具缺失')
    registry.register({
      ...provider,
      manifest: {
        ...provider.manifest,
        id: 'test-failing-inspection',
      },
      tools: () => [{
        ...failingTool,
        handler: async () => { throw new Error('数据集参数无效') },
      }],
    })
    const coordinator = new ToolExecutionCoordinator({
      store,
      registry,
      adapter: null,
      runId: 'run_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink: new ItemSink(async () => undefined, 'run_1', 'thread_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    })

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'bad' }))
      .rejects.toThrow('数据集参数无效')

    expect(transcriptWrites).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      payload: expect.objectContaining({
        name: 'inspect_dataset',
        label: '检查数据集',
        ledgerStatus: 'failed',
      }),
    }))
    expect(warnings).toContain('工具“检查数据集”调用失败：数据集参数无效')
    expect(errors).toContain('数据集参数无效')
    expect(failedTool).toBe('inspect_dataset')
  })
})

function testProvider(): ToolProvider {
  const definition = {
    name: 'inspect_dataset',
    label: '检查数据集',
    description: '检查测试数据集。',
    prompt: '读取并检查测试数据集，不修改数据。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string' } },
      required: ['datasetId'],
    },
  }
  return {
    manifest: {
      id: 'test-inspection',
      name: '测试检查工具',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: '测试工具 Provider。',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => ({
        message: '检查完成',
        payload: {},
        warnings: [],
        resultId: 'result_1',
        source: 'test',
      }),
    }],
  }
}
