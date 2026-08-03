// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行协调器测试
//
//   文件:       toolExecutionCoordinator.test.ts
//
//   日期:       2026年06月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { ItemSink } from '../conversation/itemSink.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolProvider, ToolResult } from '../framework/types.js'
import type { AgentWorkflow } from '../schemas/types.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import { formatToolResultForModel, ToolExecutionCoordinator, validateAgentWorkflowDraft } from './toolExecutionCoordinator.js'
import { RunEventSink } from './turnRunner.js'
import { createAgentWorkflow } from './agentWorkflowState.js'

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

  it('keeps non-blocking planning guidance visible in summarized tool results', () => {
    const result: ToolResult = {
      message: '计划发现完成',
      payload: { rows: Array.from({ length: 100 }, (_, index) => ({ index, value: 'x'.repeat(50) })) },
      warnings: [],
      resultId: 'result_planning',
      source: 'test',
      valueRefs: [],
    }

    const formatted = JSON.parse(formatToolResultForModel(result, 400, true)) as Record<string, unknown>

    expect(formatted).toMatchObject({
      planningContext: {
        status: 'active',
        actions: ['继续无副作用读取', 'request_clarification', 'submit_agent_workflow', '直接说明计划'],
      },
    })
    expect(JSON.stringify(formatted)).toContain('计划本身不会替代有副作用工具各自的审批')
  })

  it('keeps GeoJSON feature properties while removing oversized coordinates', () => {
    const names = [
      '上城区', '拱墅区', '西湖区', '滨江区', '余杭区', '萧山区', '临平区',
      '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市',
    ]
    const result: ToolResult = {
      message: '读取 13 / 13 个要素',
      payload: {
        featureCollection: {
          type: 'FeatureCollection',
          features: names.map((name, index) => ({
            type: 'Feature',
            geometry: {
              type: 'MultiPolygon',
              coordinates: [[Array.from({ length: 400 }, (_, point) => [point, index])]],
            },
            properties: { name, adcode: 330100 + index },
          })),
        },
      },
      warnings: [],
      resultId: 'result_hangzhou',
      source: 'postgis',
    }

    const serialized = formatToolResultForModel(result, 1200)
    const formatted = JSON.parse(serialized) as {
      payloadSummary: {
        featureCollection: {
          featureCount: number
          propertyRowsComplete: boolean
          propertyRows: Array<{ properties: { name: string } }>
        }
      }
    }

    expect(formatted.payloadSummary.featureCollection).toMatchObject({
      featureCount: 13,
      propertyRowsComplete: true,
    })
    expect(formatted.payloadSummary.featureCollection.propertyRows.map(row => row.properties.name)).toEqual(names)
    expect(serialized).not.toContain('coordinates')
  })
})

describe('ToolExecutionCoordinator', () => {
  it('opens SDK extensions only for unstructured execution without an active workflow', () => {
    let planMode = false
    let agentWorkflow: Record<string, unknown> | null = null
    const store = {
      getRun: () => ({ state: { planMode, agentWorkflow } }),
    } as unknown as ToolExecutionStore
    const coordinator = new ToolExecutionCoordinator({
      store,
      registry: new ToolRegistry(),
      adapter: null,
      runId: 'run_extension_boundary',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_extension_boundary', 'thread_1'),
      itemSink: new ItemSink(() => undefined, 'run_extension_boundary', 'thread_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    })

    expect(coordinator.isSdkExtensionEnabled()).toBe(true)
    planMode = true
    expect(coordinator.isSdkExtensionEnabled()).toBe(false)
    planMode = false
    agentWorkflow = { status: 'running' }
    expect(coordinator.isSdkExtensionEnabled()).toBe(false)
  })

  it('rejects unknown tools and cyclic dependencies in workflow drafts', () => {
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const step = (stepId: string, toolName: string, dependsOn: string[] = []) => ({
      stepId,
      title: stepId,
      kind: 'tool',
      toolName,
      ownerAgentId: 'supervisor',
      args: {},
      reason: '测试计划契约',
      dependsOn,
    })

    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误工具', steps: [step('step_1', 'render_map')] },
    }, registry, [])).toContain("未注册的 Agent 工具 'render_map'")
    expect(validateAgentWorkflowDraft({
      workflow: {
        goal: '循环依赖',
        steps: [
          step('step_1', 'inspect_dataset', ['step_2']),
          step('step_2', 'inspect_dataset', ['step_1']),
        ],
      },
    }, registry, [])).toContain('步骤依赖形成了循环')
  })

  it('validates planned argument shapes and subagent tool permissions before approval', () => {
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const baseStep = {
      stepId: 'step_1',
      title: '检查数据集',
      kind: 'tool',
      toolName: 'inspect_dataset',
      ownerAgentId: 'supervisor',
      reason: '验证预计参数',
      dependsOn: [],
    }

    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误参数', steps: [{ ...baseStep, args: { unknown: true } }] },
    }, registry, [])).toContain('预计参数不符合')
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '动态参数稍后补充', steps: [{ ...baseStep, args: {} }] },
    }, registry, [])).toBeNull()

    const agentStep = {
      ...baseStep,
      kind: 'agent',
      toolName: 'spatial_analyst',
      ownerAgentId: 'spatial_analyst',
      args: subAgentArgs('请调用 inspect_dataset 完成检查'),
    }
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '越权委托', steps: [agentStep] },
    }, registry, [{ agentId: 'spatial_analyst', tools: [] }])).toContain("未授权工具 'inspect_dataset'")
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '合法委托', steps: [agentStep] },
    }, registry, [{ agentId: 'spatial_analyst', tools: ['inspect_dataset'] }])).toBeNull()
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误的终态转交', steps: [{ ...agentStep, toolName: 'terminal_specialist', ownerAgentId: 'terminal_specialist' }] },
    }, registry, [{ agentId: 'terminal_specialist', tools: [], delegationMode: 'handoff' }])).toContain(
      "Handoff 子智能体 'terminal_specialist' 会直接接管最终对话",
    )
  })

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
        state: { planMode: false, agentWorkflow: null, todos: [], artifacts: [], warnings, errors },
      })),
      mutateRunState: vi.fn(async (_runId: string, mutation: (state: {
        planMode: boolean
        agentWorkflow: null
        todos: never[]
        artifacts: never[]
        warnings: string[]
        errors: string[]
      }) => Record<string, unknown>) => {
        const state = { planMode: false, agentWorkflow: null, todos: [], artifacts: [], warnings, errors }
        const updates = mutation(state)
        warnings = Array.isArray(updates.warnings) ? updates.warnings as string[] : warnings
        errors = Array.isArray(updates.errors) ? updates.errors as string[] : errors
        failedTool = typeof updates.failedTool === 'string' ? updates.failedTool : failedTool
        return { workspaceId: 'workspace_1', state: { ...state, ...updates } }
      }),
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

  it('derives planning access from the tool read/write contract', async () => {
    const { coordinator } = coordinatorHarness(testProvider(), true)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .resolves.toMatchObject({ message: '检查完成' })
  })

  it('blocks write tools while planning without a second allowlist', async () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const writeTool = { ...base, isReadOnly: false }
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [{
          ...provider.manifest.tools[0]!,
          isReadOnly: false,
        }],
      },
      tools: () => [writeTool],
    }, true)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(false)
    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .rejects.toThrow("计划模式只允许无副作用的读取工具")
  })

  it('does not disable read-only discovery after an unrelated rejection', () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const discoveryTool = { ...base }
    const clarificationTool = {
      ...base,
      name: 'request_clarification',
      label: '请求澄清',
    }
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [
          { ...provider.manifest.tools[0]! },
          { ...provider.manifest.tools[0]!, name: 'request_clarification', label: '请求澄清' },
        ],
      },
      tools: () => [discoveryTool, clarificationTool],
    }, true, [{
      action: 'submit_agent_workflow',
      status: 'rejected',
      payload: { consumed: false },
    }])

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.isToolEnabled('request_clarification')).toBe(true)
  })

  it('exposes only ready workflow steps and recovery controls after approval', () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const controls = [
      ['request_clarification', '请求澄清'],
      ['revise_agent_workflow', '调整智能体工作流'],
      ['todo_write', '更新任务清单'],
    ].map(([name, label]) => ({
      ...base,
      name: name!,
      label: label!,
    }))
    const workflow = createAgentWorkflow({
      goal: '检查数据集',
      steps: [{
        stepId: 'step_1',
        title: '检查数据集',
        kind: 'tool',
        toolName: 'inspect_dataset',
        ownerAgentId: 'supervisor',
        args: { datasetId: 'dataset_1' },
        reason: '验证运行边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [
          provider.manifest.tools[0]!,
          ...controls.map(tool => ({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            group: tool.group,
            tags: tool.tags,
            isReadOnly: tool.isReadOnly,
            isDestructive: tool.isDestructive,
            jsonSchema: tool.jsonSchema!,
          })),
        ],
      },
      tools: () => [base, ...controls],
    }, false, [], workflow)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.isToolEnabled('request_clarification')).toBe(true)
    expect(coordinator.isToolEnabled('revise_agent_workflow')).toBe(true)
    expect(coordinator.isToolEnabled('todo_write')).toBe(false)
  })

  it('keeps read-only diagnostics available after a workflow step fails', async () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const workflow = createAgentWorkflow({
      goal: '检查数据集',
      steps: [{
        stepId: 'step_1',
        title: '检查数据集',
        kind: 'tool',
        toolName: 'inspect_dataset',
        ownerAgentId: 'supervisor',
        args: { datasetId: 'broken' },
        reason: '验证失败后的恢复边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness({
      ...provider,
      tools: () => [{
        ...base,
        handler: async () => { throw new Error('数据集缺少预报时效') },
      }],
    }, false, [], workflow)

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'broken' }))
      .rejects.toThrow('数据集缺少预报时效')

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.formatToolFailureForModel('inspect_dataset', '数据集缺少预报时效'))
      .toContain('可以调用已注册的无副作用读取工具诊断原因')
    expect(coordinator.formatUnavailableToolForModel('meteorological_inspect'))
      .toContain('只能使用已注册的无副作用读取工具诊断')
  })

  it('binds reverse and concurrent same-tool calls to explicit workflow step ids', async () => {
    const workflow = createAgentWorkflow({
      goal: '分别检查两个数据集',
      steps: [
        {
          stepId: 'inspect_a',
          title: '检查数据集 A',
          kind: 'tool',
          toolName: 'inspect_dataset',
          ownerAgentId: 'supervisor',
          args: { datasetId: 'dataset_a' },
          reason: '检查 A',
          dependsOn: [],
        },
        {
          stepId: 'inspect_b',
          title: '检查数据集 B',
          kind: 'tool',
          toolName: 'inspect_dataset',
          ownerAgentId: 'supervisor',
          args: { datasetId: 'dataset_b' },
          reason: '检查 B',
          dependsOn: [],
        },
      ],
    })
    const { coordinator, getState } = coordinatorHarness(testProvider(), false, [], workflow)

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_b' }))
      .rejects.toThrow('必须通过 workflowStepId 指定')

    await Promise.all([
      coordinator.executeDirect('inspect_dataset', {
        datasetId: 'dataset_b',
        workflowStepId: 'inspect_b',
      }),
      coordinator.executeDirect('inspect_dataset', {
        datasetId: 'dataset_a',
        workflowStepId: 'inspect_a',
      }),
    ])

    expect(getState().agentWorkflow?.steps.map(step => [step.stepId, step.status])).toEqual([
      ['inspect_a', 'completed'],
      ['inspect_b', 'completed'],
    ])
  })

  it('opens a subagent internal tool only while its approved agent step is running', async () => {
    const workflow = createAgentWorkflow({
      goal: '委托检查数据集',
      steps: [{
        stepId: 'step_agent',
        title: '委托空间智能体',
        kind: 'agent',
        toolName: 'spatial_analyst',
        ownerAgentId: 'spatial_analyst',
        args: subAgentArgs('检查数据集'),
        reason: '验证子智能体工具边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness(testProvider(), false, [], workflow)

    expect(coordinator.isExternalAgentEnabled('spatial_analyst')).toBe(true)
    expect(coordinator.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(false)
    await coordinator.beginExternalAgentStep(
      'spatial_analyst',
      subAgentArgs('检查数据集'),
      'call_subagent',
    )
    expect(coordinator.isExternalAgentEnabled('spatial_analyst')).toBe(false)
    expect(coordinator.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(true)
  })

  it('blocks subagents until the submitted workflow is approved', async () => {
    const { coordinator } = coordinatorHarness(testProvider(), true)

    expect(coordinator.isExecutionEnabled()).toBe(false)
    await expect(coordinator.beginExternalAgentStep(
      'spatial_analyst',
      subAgentArgs('分析当前图层'),
      'call_subagent',
    )).rejects.toThrow("计划模式禁止调用子智能体 'spatial_analyst'")
  })
})

function coordinatorHarness(
  provider: ToolProvider,
  planMode: boolean,
  approvals: Array<{ action: string; status: string; payload: Record<string, unknown> }> = [],
  agentWorkflow: AgentWorkflow | null = null,
): {
  coordinator: ToolExecutionCoordinator
  getState: () => {
    agentWorkflow: AgentWorkflow | null
  }
} {
  let state = {
    planMode,
    agentWorkflow,
    todos: [],
    warnings: [],
    errors: [],
    failedTool: null as string | null,
    subAgents: [],
    toolValueRefs: [],
    artifacts: [],
    toolResults: [],
    decisions: [],
    approvals,
  }
  let transcriptSequence = 0
  const store = {
    runtimeRoot: 'C:/runtime',
    activeTranscript: vi.fn(async () => []),
    appendTranscript: vi.fn(async () => ({ entryId: `entry_${++transcriptSequence}` })),
    saveRunCheckpoint: vi.fn(async () => undefined),
    appendToolValue: vi.fn(async () => undefined),
    persistArtifact: vi.fn(async () => undefined),
    getRun: vi.fn(() => ({ workspaceId: 'workspace_1', state })),
    commitToolResult: vi.fn(async (
      _runId: string,
      _resultId: string,
      mutation: (current: typeof state) => Partial<typeof state>,
      _values: readonly unknown[],
      _artifacts: readonly unknown[],
    ) => {
      state = { ...state, ...mutation(state) }
    }),
    mutateRunState: vi.fn(async (_runId: string, mutation: (current: typeof state) => Partial<typeof state>) => {
      state = { ...state, ...mutation(state) }
      return { workspaceId: 'workspace_1', state }
    }),
    updateRunState: vi.fn(async (_runId: string, updates: Partial<typeof state>) => {
      state = { ...state, ...updates }
    }),
  } as unknown as ToolExecutionStore
  const registry = new ToolRegistry()
  registry.register(provider)
  return {
    coordinator: new ToolExecutionCoordinator({
      store,
      registry,
      adapter: null,
      runId: 'run_plan_boundary',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_plan_boundary', 'thread_1'),
      itemSink: new ItemSink(async () => undefined, 'run_plan_boundary', 'thread_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    }),
    getState: () => state,
  }
}

function subAgentArgs(objective: string) {
  return {
    workflowStepId: 'step_agent',
    objective,
    expectedDeliverables: ['可核验分析结论'],
    contextRefs: [],
    constraints: [],
  }
}

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
