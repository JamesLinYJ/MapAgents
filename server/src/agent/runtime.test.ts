// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行时契约测试
//
//   文件:       runtime.test.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import type { Env } from '../framework/env.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider, ToolResult, ValueRef } from '../framework/types.js'
import { ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import {
  subAgentDeliverySchema,
  supervisorDeliverySchema,
  type ConversationItem,
} from '../schemas/types.js'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { createTestPersistenceFacade, PersistenceFacadeTestHarness } from '../../test-support/persistenceFacadeHarness.js'
import planProvider from '../tools/plan/index.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { OpenAIAgentsRuntime, type SandboxSessionFactory } from './runtime.js'

async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

const testSandboxSessionFactory: SandboxSessionFactory = async manifest => ({
  state: { manifest, workspaceReady: true },
  createEditor: () => ({
    createFile: async () => { throw new Error('测试 sandbox 不允许写入文件') },
    updateFile: async () => { throw new Error('测试 sandbox 不允许修改文件') },
    deleteFile: async () => { throw new Error('测试 sandbox 不允许删除文件') },
  }),
  execCommand: async () => { throw new Error('测试 sandbox 不允许执行 shell 命令') },
  supportsPty: () => false,
  close: async () => {},
})

function testRuntime(
  store: PlatformPersistenceFacade,
  tools: ToolRegistry,
  models: ModelAdapterRegistry,
): OpenAIAgentsRuntime {
  return new OpenAIAgentsRuntime(store, tools, models, {
    createSandboxSession: testSandboxSessionFactory,
  })
}

describe('OpenAIAgentsRuntime delivery boundaries', () => {
  it('distinguishes platform artifact IDs from valueRef IDs at the structured-output schema boundary', () => {
    const supervisor = {
      markdown: '完成。',
      summary: '完成。',
      artifactIds: ['ref_not_an_artifact'],
      warnings: [],
    }
    const subAgent = {
      status: 'completed',
      summary: '完成。',
      evidence: [{ claim: '已查询', source: 'ref_query_result' }],
      artifactIds: ['ref_query_result'],
      warnings: [],
      error: null,
    }

    expect(supervisorDeliverySchema.safeParse(supervisor).success).toBe(false)
    expect(subAgentDeliverySchema.safeParse(subAgent).success).toBe(false)
    expect(supervisorDeliverySchema.safeParse({
      ...supervisor,
      artifactIds: ['artifact_query_result'],
    }).success).toBe(true)
    expect(subAgentDeliverySchema.safeParse({
      ...subAgent,
      artifactIds: ['artifact_query_result'],
    }).success).toBe(true)
  })

  it('releases the active-run lifecycle when the first persistence write fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-initialization-failure-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '初始化失败清理')
      const run = await store.createRun(session.id, '验证初始化失败后可以重试', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const originalUpdateRunStatus = store.updateRunStatus.bind(store)
      let failFirstWrite = true
      store.updateRunStatus = async (...args) => {
        if (failFirstWrite) {
          failFirstWrite = false
          throw new Error('注入的首次状态写入失败')
        }
        return originalUpdateRunStatus(...args)
      }
      const runtime = testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '重试完成。' })))),
      )

      const failed = await runtime.run(runOptions(run, thread.id))
      expect(failed.status).toBe('failed')
      expect(failed.state.errors).toContain('注入的首次状态写入失败')

      const completed = await runtime.run(runOptions(run, thread.id))
      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toContain('注入的首次状态写入失败')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rebuilds the visible transcript after restart and sends the current user message once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-continuation-'))
    try {
      const requests: ModelRequest[] = []
      let responseNumber = 0
      const model = scriptedModel(request => {
        requests.push(request)
        responseNumber += 1
        return { text: responseNumber === 1 ? '项目代号是西湖。' : '我记得，项目代号是西湖。' }
      })
      const models = registryWith(fakeAdapter(model))
      const harness = new PersistenceFacadeTestHarness()
      const firstStore = harness.create(root)
      await firstStore.initialize()
      const session = await firstStore.createSession()
      const thread = await firstStore.createThread(session.id, '连续对话')
      const firstRun = await firstStore.createRun(session.id, '记住项目代号是西湖', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await testRuntime(firstStore, new ToolRegistry(), models).run(runOptions(firstRun, thread.id))
      await firstStore.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      const secondRun = await restoredStore.createRun(session.id, '刚才的项目代号是什么？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await testRuntime(restoredStore, new ToolRegistry(), models).run(runOptions(secondRun, thread.id))

      const secondTexts = requestTexts(requests[1])
      expect(secondTexts).toContain('记住项目代号是西湖')
      expect(secondTexts).toContain('项目代号是西湖。')
      expect(secondTexts.filter(text => text === secondRun.userQuery)).toHaveLength(1)
      const transcript = await restoredStore.activeTranscript(thread.id)
      const assistantEntries = transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'assistant')
      expect(assistantEntries.map(entry => entry.payload.content)).toEqual([
        '项目代号是西湖。',
        '我记得，项目代号是西湖。',
      ])
      const secondItems = await restoredStore.listItems(secondRun.id)
      expect(secondItems.filter(item => item.role === 'assistant' && item.body === '我记得，项目代号是西湖。'))
        .toHaveLength(1)
      expect(secondItems.find(item => item.body === '我记得，项目代号是西湖。')?.metadata.transcriptEntryId)
        .toBe(assistantEntries[1].entryId)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('persists an SDK approval interruption and resumes it once after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-approval-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '审批测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      const run = await store.createRun(session.id, '执行敏感工具', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(approvalProvider(() => { executions += 1 }))
      const model = scriptedModel(request => hasToolResult(request)
        ? { text: '工具已执行。' }
        : { toolCalls: [{ id: 'call_1', name: 'sensitive_tool', arguments: '{"value":1}' }] })
      const models = registryWith(fakeAdapter(model))

      const waiting = await testRuntime(store, tools, models).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })
      expect(waiting.state.errors).toEqual([])
      expect(waiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(waiting.state.approvals).toHaveLength(1)
      expect(waiting.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'pending',
        title: '批准执行：执行敏感操作',
      }))
      await store.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      const completed = await testRuntime(restoredStore, tools, models)
        .resolveApproval(run.id, waiting.state.approvals[0].approvalId, true)

      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.approvals[0].payload.consumed).toBe(true)
      expect(completed.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'approved',
        resolvedAt: expect.any(String),
      }))
      const transcript = await restoredStore.activeTranscript(thread.id)
      expect(transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'user')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_call')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_result')).toHaveLength(1)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('exposes only declared discovery tools in explicit plan mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-boundary-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式写入边界')
      const run = await store.createRun(session.id, '先计划再写入', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let executions = 0
      let visibleTools: string[] = []
      const tools = new ToolRegistry()
      tools.register(providerFromTools('plan-boundary-tools', [
        {
          ...toolDefinition('lookup_context', ['query']),
          planModeAccess: 'discovery',
          handler: async () => result('lookup', [], { ok: true }),
        },
        {
          ...toolDefinition('query_layer', ['query']),
          handler: async () => {
            executions += 1
            return result('query', [], { ok: true })
          },
        },
        {
          ...toolDefinition('write_layer', ['value']),
          isReadOnly: false,
          handler: async () => {
            executions += 1
            return result('write', [], { ok: true })
          },
        },
      ]))
      const model = scriptedModel(request => {
        visibleTools = request.tools.map(tool => tool.name)
        return { text: '我会先整理计划。' }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(executions).toBe(0)
      expect(completed.state.planMode).toBe(true)
      expect(visibleTools).toContain('lookup_context')
      expect(visibleTools).not.toContain('query_layer')
      expect(visibleTools).not.toContain('write_layer')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('allows text-only planning discussion without representing it as approved execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-text-only-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '文字计划禁止假成功')
      const run = await store.createRun(session.id, '先给我计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const model = scriptedModel(() => ({ text: '计划：第一步检查，第二步执行。' }))

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.agentWorkflow).toBeNull()
      expect(completed.state.errors).toEqual([])
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'message',
        payload: expect.objectContaining({ role: 'assistant', content: '计划：第一步检查，第二步执行。' }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('records a dynamically unavailable platform tool as an SDK rejection and lets the model recover', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-tool-not-found-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式工具不可用恢复')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '先尝试查询再调整', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(providerFromTools('plan-tool-not-found', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          executions += 1
          return result('不应执行', [], {})
        },
      }]))
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'query_layer')) {
          return { text: '当前模式不能直接查询，我会先形成计划。' }
        }
        return {
          toolCalls: [{
            id: 'call_unavailable_query',
            name: 'query_layer',
            arguments: '{"query":"杭州"}',
          }],
        }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(executions).toBe(0)
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          callId: 'call_unavailable_query',
          name: 'query_layer',
          ledgerStatus: 'rejected',
          source: 'openai_agents_sdk',
        }),
      }))
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        payload: expect.objectContaining({
          callId: 'call_unavailable_query',
          ledgerStatus: 'rejected',
          source: 'openai_agents_sdk',
        }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('records a hallucinated unknown tool as an SDK rejection instead of a sandbox execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-unknown-tool-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '未知工具投影')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '调用一个不存在的工具后恢复', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'invented_tool')) {
          return { text: '这个工具不存在，我不会伪造执行结果。' }
        }
        return {
          toolCalls: [{
            id: 'call_invented_tool',
            name: 'invented_tool',
            arguments: '{}',
          }],
        }
      })

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          callId: 'call_invented_tool',
          name: 'invented_tool',
          ledgerStatus: 'rejected',
          source: 'openai_agents_sdk',
        }),
      }))
      expect(transcript).not.toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({
          callId: 'call_invented_tool',
          source: 'openai_agents_sandbox',
        }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rejects a plain-text terminal after dynamically entering plan mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-dynamic-plan-terminal-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '动态计划模式终态边界')
      const run = await store.createRun(session.id, '帮我做一张风险区划图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const requests: ModelRequest[] = []
      let turns = 0
      const model = scriptedModel(request => {
        requests.push(request)
        turns += 1
        if (turns === 1) {
          return {
            toolCalls: [{
              id: 'call_enter_plan_mode',
              name: 'enter_plan_mode',
              arguments: JSON.stringify({ reason: '需要先规划' }),
            }],
          }
        }
        return { text: '请先上传数据，我再继续。' }
      })

      const failed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(run, thread.id))

      expect(failed.status).toBe('failed')
      expect(failed.state.planMode).toBe(true)
      expect(failed.state.agentWorkflow).toBeNull()
      expect(failed.state.errors.at(-1)).toContain('计划模式不能以普通正文结束')
      expect(requests).toHaveLength(2)
      expect(requests[1]?.systemInstructions).toContain('必须调用 request_clarification')
      expect(JSON.stringify(requests[1])).toContain('planningContract')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rejects completion while a visible Todo is still pending or running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-incomplete-todo-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Todo 完成边界')
      const run = await store.createRun(session.id, '完成当前任务', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await store.updateRunState(run.id, {
        todos: [{
          todoId: 'todo_1',
          title: '执行尚未完成的步骤',
          status: 'running',
          description: null,
          activeForm: '正在执行',
          ownerAgentId: 'supervisor',
          stepId: null,
        }],
      })
      const model = scriptedModel(() => ({ text: '任务已经完成。' }))

      const failed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
      })

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.at(-1)).toContain('运行仍有未完成 Todo')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('answers a greeting directly in explicit plan mode without manufacturing a clarification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-greeting-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式寒暄')
      const run = await store.createRun(session.id, '你好', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const model = scriptedModel(() => ({ text: '你好！有什么可以帮你分析？' }))

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.clarification).toBeNull()
      expect(completed.state.decisions).toEqual([])
      expect(completed.state.errors).toEqual([])
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'message',
        payload: expect.objectContaining({ role: 'assistant', content: '你好！有什么可以帮你分析？' }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('requires the clarification tool when the planning goal is underspecified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-clarify-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式澄清')
      const run = await store.createRun(session.id, '生成一份计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const model = scriptedModel(() => ({
        toolCalls: [{
          id: 'call_clarify_plan',
          name: 'request_clarification',
          arguments: JSON.stringify({
            question: '请告诉我这份计划要解决什么任务，以及需要使用哪些数据或输出什么结果？',
            reason: '用户要求生成计划，但没有提供可规划目标和输出边界。',
            options: [],
            allowFreeText: true,
          }),
        }],
      }))

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(waiting.status).toBe('clarification_needed')
      expect(waiting.state.planMode).toBe(true)
      expect(waiting.state.clarification).toMatchObject({
        kind: 'plan_requirement',
        question: '请告诉我这份计划要解决什么任务，以及需要使用哪些数据或输出什么结果？',
        reason: '用户要求生成计划，但没有提供可规划目标和输出边界。',
        allowFreeText: true,
      })
      expect(waiting.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.clarification?.clarificationId,
        kind: 'clarification',
        status: 'pending',
        allowFreeText: true,
      }))
      expect(waiting.state.errors).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('reviews submit_agent_workflow through approval and persists the approved execution plan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-approval-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划审批')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = []
      const run = await store.createRun(session.id, '给我做一个风险区划图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      const workflow = {
        goal: '生成短时强降水风险区划图',
        steps: [
          {
            stepId: 'step_1',
            title: '交付风险区划说明',
            kind: 'delivery',
            toolName: 'deliver_test_response',
            ownerAgentId: 'supervisor',
            args: { question: '风险区划结果' },
            reason: '交付经过验证的最终回答',
            dependsOn: [],
          },
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [{ id: 'call_delivery', name: 'deliver_test_response', arguments: '{"question":"风险区划结果"}' }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        executionMode: 'plan',
      })

      expect(waiting.status).toBe('waiting_approval')
      expect(waiting.state.planMode).toBe(true)
      expect(waiting.state.agentWorkflow).toBeNull()
      expect(waiting.state.approvals).toHaveLength(1)
      expect(waiting.state.approvals[0]).toMatchObject({
        action: 'submit_agent_workflow',
        title: '批准这个智能体工作流？',
        status: 'pending',
      })
      expect(waiting.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'pending',
        title: '批准这个智能体工作流？',
      }))
      expect(waiting.state.approvals[0].payload.args).toMatchObject({ workflow })
      await store.updateRunState(run.id, {
        todos: [{
          todoId: 'todo_step_1',
          title: '交付风险区划说明',
          status: 'pending',
          description: null,
          activeForm: '正在交付风险区划说明',
          ownerAgentId: 'supervisor',
          stepId: 'step_1',
        }],
      })
      await store.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      const completed = await testRuntime(restoredStore, tools, registryWith(fakeAdapter(model)))
        .resolveApproval(run.id, waiting.state.approvals[0].approvalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(false)
      expect(completed.state.agentWorkflow).toMatchObject({
        goal: workflow.goal,
        status: 'completed',
        revision: 1,
        steps: [expect.objectContaining({ stepId: 'step_1', status: 'completed' })],
      })
      expect(completed.state.todos).toEqual([
        expect.objectContaining({ stepId: 'step_1', status: 'completed' }),
      ])
      expect(completed.state.approvals[0].payload.consumed).toBe(true)
      expect(completed.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'approved',
        resolvedAt: expect.any(String),
      }))
      const items = await restoredStore.listItems(run.id)
      expect(items.some(item => item.itemType === 'result' && item.metadata?.resultType === 'waiting_approval')).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('preserves a replacement workflow approval after the previous plan is rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-reapproval-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划退回后重新审批')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '生成杭州市行政区划地图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      const workflow = (title: string) => ({
        goal: '生成杭州市行政区划地图',
        steps: [workflowStep('step_delivery', title, 'deliver_test_response')],
      })
      let modelTurn = 0
      const model = scriptedModel(() => {
        modelTurn += 1
        if (modelTurn === 1 || modelTurn === 2) {
          return {
            toolCalls: [{
              id: `call_plan_${modelTurn}`,
              name: 'submit_agent_workflow',
              arguments: JSON.stringify({
                workflow: workflow(modelTurn === 1 ? '交付初版地图' : '交付修订地图'),
              }),
            }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_delivery_after_reapproval',
            name: 'deliver_test_response',
            arguments: '{"question":"行政区划地图"}',
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const firstWaiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const firstApprovalId = firstWaiting.state.approvals[0]?.approvalId
      if (!firstApprovalId) throw new Error('测试没有生成首个工作流审批。')

      const secondWaiting = await runtime.resolveApproval(run.id, firstApprovalId, false)
      const pendingApprovals = secondWaiting.state.approvals.filter(item => item.status === 'pending')

      expect(secondWaiting.status).toBe('waiting_approval')
      expect(secondWaiting.state.approvals).toHaveLength(2)
      expect(secondWaiting.state.approvals.find(item => item.approvalId === firstApprovalId)).toMatchObject({
        status: 'rejected',
        payload: { consumed: true },
      })
      expect(pendingApprovals).toHaveLength(1)
      expect(pendingApprovals[0]?.payload.args).toMatchObject({
        workflow: { steps: [expect.objectContaining({ title: '交付修订地图' })] },
      })

      const secondApprovalId = pendingApprovals[0]?.approvalId
      if (!secondApprovalId) throw new Error('测试没有保留替换后的工作流审批。')
      const completed = await runtime.resolveApproval(run.id, secondApprovalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.approvals.find(item => item.approvalId === secondApprovalId)).toMatchObject({
        status: 'approved',
        payload: { consumed: true },
      })
      expect(completed.state.agentWorkflow?.steps).toContainEqual(expect.objectContaining({
        title: '交付修订地图',
        status: 'completed',
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK input guardrail to repair unknown workflow tools before requesting approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-tool-guardrail-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划工具契约护栏')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '生成可审批地图计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      let modelTurn = 0
      let firstRequest: ModelRequest | null = null
      const model = scriptedModel(request => {
        modelTurn += 1
        firstRequest ??= request
        const selectedTool = modelTurn === 1 ? 'render_map' : 'deliver_test_response'
        return {
          toolCalls: [{
            id: `guarded_plan_${modelTurn}`,
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({
              workflow: {
                goal: '交付地图',
                steps: [workflowStep('step_delivery', '交付地图', selectedTool)],
              },
            }),
          }],
        }
      })

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })

      expect(modelTurn).toBe(2)
      expect(waiting.status).toBe('waiting_approval')
      expect(waiting.state.approvals).toHaveLength(1)
      expect(waiting.state.approvals[0]?.payload.args).toMatchObject({
        workflow: { steps: [expect.objectContaining({ toolName: 'deliver_test_response' })] },
      })
      expect(firstRequest?.systemInstructions).toContain('deliver_test_response')
      expect(firstRequest?.tools.map(tool => tool.name)).not.toContain('deliver_test_response')
      expect((await store.getRunCheckpoint(run.id)).pendingToolCallIds).toEqual([])
      expect(waiting.state.errors).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it.each([
    ['strict SDK null values', 'strict', {
      query: '杭州',
      category: null,
      sourceType: null,
      status: null,
      limit: 20,
    }],
    ['compatible Chat Completions omissions', 'compatible', {
      query: '杭州',
      limit: 20,
    }],
  ] as const)('restores internal optional arguments from %s', async (_case, schemaMode, toolArguments) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-optional-tool-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '可选参数工具')
      const run = await store.createRun(session.id, '查杭州图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let executedArgs: Record<string, unknown> | null = null
      const tools = new ToolRegistry()
      tools.register(providerFromTools('optional-tool-provider', [{
        name: 'list_layers',
        label: '检索图层',
        description: '检索图层',
        prompt: '用于测试可选参数省略时的工具调用。',
        group: '测试',
        tags: [],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            category: { type: 'string' },
            sourceType: { type: 'string' },
            status: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        handler: async (args) => {
          executedArgs = args
          return result('layers', [], { count: 0, layers: [] })
        },
      }]))
      const model = scriptedModel(request => hasToolResultNamed(request, 'list_layers')
        ? { text: '没有找到匹配的已注册图层。' }
        : {
            toolCalls: [{
              id: 'call_layers',
              name: 'list_layers',
              arguments: JSON.stringify(toolArguments),
            }],
          })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model, schemaMode))).run(runOptions(run, thread.id))

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(executedArgs).toEqual({ query: '杭州', limit: 20 })
      const checkpoint = await store.getRunCheckpoint(run.id)
      expect(checkpoint.pendingToolCallIds).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('executes independent agent workflow steps concurrently without losing persisted results', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-parallel-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行智能体工作流')
      const config = testRuntimeConfig()
      config.maxFunctionToolConcurrency = 4
      const run = await store.createRun(session.id, '并行检查两类数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let active = 0
      let maxActive = 0
      const parallelTool = (name: 'parallel_a' | 'parallel_b'): ToolDef => ({
        ...toolDefinition(name, []),
        handler: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 40))
          active -= 1
          return result(name, [], { name })
        },
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(providerFromTools('parallel-agent-workflow', [parallelTool('parallel_a'), parallelTool('parallel_b')]))
      const workflow = {
        goal: '并行检查两类数据',
        steps: [
          workflowStep('step_a', '检查数据 A', 'parallel_a'),
          workflowStep('step_b', '检查数据 B', 'parallel_b'),
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'parallel_a') && hasToolResultNamed(request, 'parallel_b')) {
          return { text: '两类数据均已检查完成。' }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [
              { id: 'call_parallel_a', name: 'parallel_a', arguments: '{}' },
              { id: 'call_parallel_b', name: 'parallel_b', arguments: '{}' },
            ],
          }
        }
        return {
          toolCalls: [{
            id: 'call_parallel_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')
      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.agentWorkflow?.status).toBe('completed')
      expect(completed.state.agentWorkflow?.steps.map(step => step.status)).toEqual(['completed', 'completed'])
      expect(completed.state.toolResults.filter(item => item.tool === 'parallel_a' || item.tool === 'parallel_b')).toHaveLength(2)
      expect(maxActive).toBe(2)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('requires a new approval before executing a revised failed workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-revision-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '失败后调整智能体工作流')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '检查数据并交付结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      let recoveryExecutions = 0
      tools.register(providerFromTools('agent-workflow-revision', [
        {
          ...toolDefinition('unstable_inspect', []),
          handler: async () => {
            throw new Error('主数据源校验失败')
          },
        },
        {
          ...toolDefinition('verified_recovery', []),
          handler: async () => {
            recoveryExecutions += 1
            return result('verified-recovery', [], { validated: true })
          },
        },
      ]))
      const initialWorkflow = {
        goal: '检查数据并交付结论',
        steps: [
          workflowStep('step_inspect', '检查主数据源', 'unstable_inspect'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_inspect']),
        ],
      }
      const revisedWorkflow = {
        goal: '使用已验证的恢复数据完成检查并交付结论',
        changeReason: '主数据源校验失败，必须显式改用已经验证的恢复数据。',
        steps: [
          workflowStep('step_recovery', '验证恢复数据', 'verified_recovery'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_recovery']),
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'verified_recovery')) {
          return {
            toolCalls: [{
              id: 'call_revised_delivery',
              name: 'deliver_test_response',
              arguments: '{"question":"恢复数据检查结论"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'revise_agent_workflow')) {
          return { toolCalls: [{ id: 'call_recovery', name: 'verified_recovery', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'unstable_inspect')) {
          return {
            toolCalls: [{
              id: 'call_revision',
              name: 'revise_agent_workflow',
              arguments: JSON.stringify({ workflow: revisedWorkflow }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_unstable', name: 'unstable_inspect', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_initial_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow: initialWorkflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const revisionWaiting = await runtime.resolveApproval(run.id, approval.approvalId, true)
      const revisionApproval = revisionWaiting.state.approvals.find(candidate => (
        candidate.status === 'pending' && candidate.action === 'revise_agent_workflow'
      ))
      if (!revisionApproval) throw new Error('测试没有生成工作流修订审批。')

      expect(revisionWaiting.status).toBe('waiting_approval')
      expect(recoveryExecutions).toBe(0)
      expect(revisionWaiting.state.agentWorkflow).toMatchObject({ revision: 1, status: 'adjusting' })
      expect(revisionApproval.payload.args).toMatchObject({ workflow: revisedWorkflow })

      const completed = await runtime.resolveApproval(run.id, revisionApproval.approvalId, true)

      expect(completed.id).toBe(run.id)
      expect(completed.status).toBe('completed')
      expect(recoveryExecutions).toBe(1)
      expect(completed.state.agentWorkflow).toMatchObject({
        revision: 2,
        status: 'completed',
        goal: revisedWorkflow.goal,
        changeReason: revisedWorkflow.changeReason,
      })
      expect(completed.state.agentWorkflow?.steps.map(step => [step.stepId, step.status])).toEqual([
        ['step_recovery', 'completed'],
        ['step_delivery', 'completed'],
      ])
      const events = await store.listEvents(run.id)
      expect(events.some(event => event.type === 'agent_workflow.revised')).toBe(true)
      expect(events.some(event => event.type === 'warning.raised' && event.message.includes('主数据源校验失败'))).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('recovers from a model-invented tool after workflow failure without hiding the root cause', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-missing-tool-recovery-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '失败后未知工具恢复')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '检查数据并在缺少输入时询问用户', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(providerFromTools('missing-tool-recovery', [{
        ...toolDefinition('unstable_inspect', []),
        handler: async () => { throw new Error('主数据源校验失败') },
      }]))
      const workflow = {
        goal: '检查主数据源',
        steps: [workflowStep('step_inspect', '检查主数据源', 'unstable_inspect')],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'meteorological_inspect')) {
          return {
            toolCalls: [{
              id: 'call_missing_input',
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: '主数据源校验失败。请上传包含可解析预报时效的数据后再继续。',
                reason: '现有输入无法形成可靠的替代执行路径。',
                options: [],
                allowFreeText: true,
              }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'unstable_inspect')) {
          return {
            toolCalls: [{
              id: 'call_invented_tool',
              name: 'meteorological_inspect',
              arguments: '{}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_unstable', name: 'unstable_inspect', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_initial_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const clarification = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(clarification.status).toBe('clarification_needed')
      expect(clarification.state.clarification).toMatchObject({
        question: '主数据源校验失败。请上传包含可解析预报时效的数据后再继续。',
      })
      expect(clarification.state.agentWorkflow?.status).toBe('adjusting')
      expect(clarification.state.errors).toContain('主数据源校验失败')
      expect(clarification.state.errors.join('\n')).not.toContain('Tool meteorological_inspect not found')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('injects user steering into the active run and revises the workflow before continuing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-steering-'))
    const releaseCollection = deferredSignal()
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行中引导智能体工作流')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '检查数据并给出结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const collectionStarted = deferredSignal()
      let tableExecutions = 0
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      tools.register(providerFromTools('agent-workflow-steering', [
        {
          ...toolDefinition('collect_guidance_data', []),
          handler: async () => {
            collectionStarted.resolve()
            await releaseCollection.promise
            return result('guidance-data', [], { rows: 12 })
          },
        },
        {
          ...toolDefinition('build_guidance_table', []),
          handler: async () => {
            tableExecutions += 1
            return result('guidance-table', [], { tableCreated: true })
          },
        },
      ]))
      const initialWorkflow = {
        goal: '检查数据并给出结论',
        steps: [
          workflowStep('step_collect', '采集检查数据', 'collect_guidance_data'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_collect']),
        ],
      }
      const revisedWorkflow = {
        goal: '检查数据、生成表格并给出结论',
        changeReason: '用户在运行中明确要求增加可核验表格。',
        steps: [
          workflowStep('step_collect', '采集检查数据', 'collect_guidance_data'),
          workflowStep('step_table', '生成检查表格', 'build_guidance_table', ['step_collect']),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_table']),
        ],
      }
      let steeringObserved = false
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'build_guidance_table')) {
          return {
            toolCalls: [{
              id: 'call_steered_delivery',
              name: 'deliver_test_response',
              arguments: '{"question":"包含表格的检查结论"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'revise_agent_workflow')) {
          return { toolCalls: [{ id: 'call_guidance_table', name: 'build_guidance_table', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'collect_guidance_data')) {
          steeringObserved = requestTexts(request).some(text => text.includes('增加一张可核验的表格'))
          if (!steeringObserved) throw new Error('运行中的用户引导消息没有进入下一次模型调用。')
          return {
            toolCalls: [{
              id: 'call_steering_revision',
              name: 'revise_agent_workflow',
              arguments: JSON.stringify({ workflow: revisedWorkflow }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_guidance_collection', name: 'collect_guidance_data', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_guidance_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow: initialWorkflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const firstContinuation = runtime.resolveApproval(run.id, approval.approvalId, true)
      await collectionStarted.promise
      const steering = await runtime.steer(run.id, 'steer_add_table', '请增加一张可核验的表格，再给出结论。')
      releaseCollection.resolve()
      const revisionWaiting = await firstContinuation
      const revisionApproval = revisionWaiting.state.approvals.find(candidate => (
        candidate.status === 'pending' && candidate.action === 'revise_agent_workflow'
      ))
      if (!revisionApproval) throw new Error('测试没有生成用户引导后的工作流修订审批。')

      expect(revisionWaiting.status).toBe('waiting_approval')
      expect(tableExecutions).toBe(0)
      const completed = await runtime.resolveApproval(run.id, revisionApproval.approvalId, true)

      expect(completed.id).toBe(run.id)
      expect(completed.status).toBe('completed')
      expect(tableExecutions).toBe(1)
      expect(steeringObserved).toBe(true)
      expect(completed.state.agentWorkflow).toMatchObject({
        revision: 2,
        status: 'completed',
        goal: revisedWorkflow.goal,
        changeReason: revisedWorkflow.changeReason,
      })
      expect(completed.state.agentWorkflow?.steps.map(step => [step.stepId, step.status, step.attempt])).toEqual([
        ['step_collect', 'completed', 1],
        ['step_table', 'completed', 1],
        ['step_delivery', 'completed', 1],
      ])
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: steering.steeringId,
        content: steering.content,
        status: 'consumed',
      }))
    } finally {
      releaseCollection.resolve()
      await removeTempRoot(root)
    }
  })

  it('retries a replay-safe model disconnect before the first semantic event', async () => {
    let attempts = 0
    const result = await executeTextRun(scriptedModel(() => {
      attempts += 1
      if (attempts === 1) throw new ReplaySafeTestError('terminated')
      return { text: '连接恢复后的回答。' }
    }))
    expect(attempts).toBe(2)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.body === '连接恢复后的回答。')).toBe(true)
  })

  it('persists the concrete model error after the only safe retry also fails', async () => {
    const result = await executeTextRun(scriptedModel(() => {
      throw new ReplaySafeTestError('terminated')
    }))
    expect(result.run.status).toBe('failed')
    expect(result.run.state.errors[0]).toContain('terminated')
    expect(result.items.at(-1)?.metadata.message).toContain('terminated')
  })

  it('keeps normal tool preambles out of reasoning and delivers terminal tool output', async () => {
    let turns = 0
    const tools = new ToolRegistry()
    tools.register(directResponseProvider())
    const model = scriptedModel(() => {
      turns += 1
      return {
        text: '我先分析一下。',
        toolCalls: [{ id: 'answer_call', name: 'deliver_test_response', arguments: '{"question":"测试直接交付"}' }],
      }
    })
    const result = await executeTextRun(model, tools)
    expect(turns).toBe(1)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.itemType === 'reasoning' && item.body === '我先分析一下。')).toBe(false)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '我先分析一下。')).toBe(true)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '预报时段内未检出达到有效阈值的降雨。')).toBe(true)
    const preambleIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '我先分析一下。')
    const toolIndex = result.items.findIndex(item => item.itemType === 'function_call' && item.name === 'deliver_test_response')
    const finalIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '预报时段内未检出达到有效阈值的降雨。')
    expect(preambleIndex).toBeLessThan(toolIndex)
    expect(toolIndex).toBeLessThan(finalIndex)
    const transcriptToolIndex = result.transcript.findIndex(entry => entry.kind === 'tool_call' && entry.payload.name === 'deliver_test_response')
    const transcriptPreambleIndex = result.transcript.findIndex(entry => (
      entry.kind === 'checkpoint'
      && entry.payload.type === 'assistant_content_for_tool_call'
      && entry.payload.callId === 'answer_call'
    ))
    const transcriptResultIndex = result.transcript.findIndex(entry => entry.kind === 'tool_result' && entry.payload.name === 'deliver_test_response')
    const transcriptFinalIndex = result.transcript.findIndex(entry => entry.kind === 'message' && entry.payload.content === '预报时段内未检出达到有效阈值的降雨。')
    expect(result.transcript[transcriptPreambleIndex].payload.content).toBe('我先分析一下。')
    expect(transcriptToolIndex).toBeLessThan(transcriptResultIndex)
    expect(transcriptToolIndex).toBeLessThan(transcriptPreambleIndex)
    expect(transcriptResultIndex).toBeLessThan(transcriptFinalIndex)
  })

  it('keeps provider reasoning UI-only while completing a tool continuation', async () => {
    const tools = new ToolRegistry()
    tools.register(providerFromTools('reasoning-replay-test', [{
      ...toolDefinition('lookup_context', ['query']),
      handler: async () => result('lookup', [], { ok: true }),
    }]))
    let turns = 0
    let secondTurnInput: unknown[] = []
    const model = scriptedModel(request => {
      turns += 1
      if (hasToolResult(request)) {
        secondTurnInput = Array.isArray(request.input) ? request.input : []
        return { text: '工具后总结。' }
      }
      return {
        reasoning: '这里是 provider reasoning，只能用于 UI 折叠区。',
        text: '我先查询上下文。',
        toolCalls: [{ id: 'call_lookup', name: 'lookup_context', arguments: '{"query":"杭州"}' }],
      }
    })

    const outcome = await executeTextRun(model, tools)

    expect(outcome.run.status).toBe('completed')
    expect(turns).toBe(2)
    // Agents SDK 会把 reasoning 带到同一 run 的下一次 Model 请求；Chat Completions
    // 的不可重放边界在 DeepSeekChatCompletionsModel 中统一执行。
    expect(secondTurnInput.some(item => isRecord(item) && item.type === 'reasoning')).toBe(true)
    expect(outcome.items.some(item => item.itemType === 'reasoning' && item.body?.includes('provider reasoning'))).toBe(true)
    expect(outcome.items.some(item => item.itemType === 'message' && item.body === '工具后总结。')).toBe(true)
  })

  it('runs configured subagents as Agent tools with inherited model and persisted transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子 Agent 测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '执行空间分析',
        systemPrompt: '你是空间子智能体。',
        model: null,
        tools: ['query_layer'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      let subAgentToolCalls = 0
      tools.register(providerFromTools('subagent-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          subAgentToolCalls += 1
          return result('query', [], { rows: [] })
        },
      }]))
      const workflow = {
        goal: '委托空间分析子智能体检查当前图层',
        steps: [{
          stepId: 'step_spatial_agent',
          title: '委托空间分析助手',
          kind: 'agent' as const,
          toolName: 'spatial_analyst',
          ownerAgentId: 'spatial_analyst',
          args: subAgentArgs('分析当前图层', ['图层分析摘要']),
          reason: '由具备空间分析工具权限的子智能体完成专业检查',
          dependsOn: [],
        }],
      }
      let subAgentTurns = 0
      let planningTools: string[] = []
      let executionTools: string[] = []
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('空间子智能体')) {
          subAgentTurns += 1
          if (hasToolResultNamed(request, 'query_layer')) return { text: '子分析完成。' }
          return {
            toolCalls: [{
              id: 'subagent_query_call',
              name: 'query_layer',
              arguments: '{"query":"检查当前图层"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'spatial_analyst')) return { text: '主智能体已汇总子分析。' }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          executionTools = request.tools.map(tool => tool.name)
          return { toolCalls: [{ id: 'sub_call_1', name: 'spatial_analyst', arguments: JSON.stringify(subAgentArgs('分析当前图层', ['图层分析摘要'])) }] }
        }
        planningTools = request.tools.map(tool => tool.name)
        return {
          toolCalls: [{
            id: 'subagent_plan_call',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const run = await store.createRun(session.id, '请分析当前图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const liveItems: ConversationItem[] = []
      store.itemBus.subscribe(run.id, item => liveItems.push(item))
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')
      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)
      await store.flushConversationStore()

      expect({ status: completed.status, errors: completed.state.errors }).toEqual({
        status: 'completed',
        errors: [],
      })
      expect(subAgentTurns).toBe(2)
      expect(subAgentToolCalls).toBe(1)
      expect(planningTools).not.toContain('spatial_analyst')
      expect(executionTools).toContain('spatial_analyst')
      expect(executionTools).not.toContain('exec_command')
      expect(executionTools).not.toContain('read_file')
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'spatial_analyst',
        status: 'completed',
        stepIds: ['step_spatial_agent'],
        currentStepId: null,
      }))
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [expect.objectContaining({
          stepId: 'step_spatial_agent',
          kind: 'agent',
          ownerAgentId: 'spatial_analyst',
          status: 'completed',
        })],
      })
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.some(entry => entry.kind === 'tool_call' && entry.payload.name === 'spatial_analyst')).toBe(true)
      expect(transcript.some(entry => entry.kind === 'tool_result' && entry.payload.name === 'spatial_analyst')).toBe(true)
      const subAgentCallUpdates = liveItems.filter(item => (
        item.itemType === 'function_call' && item.name === 'spatial_analyst'
      ))
      expect(subAgentCallUpdates.map(item => item.status)).toEqual(['running', 'completed'])
      const queryCompletedIndex = liveItems.findIndex(item => (
        item.itemType === 'function_call_output'
        && item.name === 'query_layer'
        && item.status === 'completed'
      ))
      const subAgentCompletedIndex = liveItems.findIndex(item => (
        item.itemType === 'function_call'
        && item.name === 'spatial_analyst'
        && item.status === 'completed'
      ))
      expect(queryCompletedIndex).toBeGreaterThanOrEqual(0)
      expect(subAgentCompletedIndex).toBeGreaterThan(queryCompletedIndex)
      const agentLog = await readFile(path.join(
        root, 'sessions', session.id, 'threads', thread.id,
        'runs', run.id, 'agents', 'spatial_analyst', 'transcript.jsonl',
      ), 'utf8')
      expect(agentLog).toContain('completed_item')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('runs independent read-only subagents concurrently through one approved batch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-parallel-subagents-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行子智能体测试')
      const config = testRuntimeConfig()
      config.maxParallelSubAgents = 2
      config.subAgents = [
        {
          agentId: 'parallel_alpha',
          name: '并行甲助手',
          role: 'analyst',
          summary: '并行检查数据甲',
          systemPrompt: '你是并行甲子智能体。',
          model: null,
          tools: ['parallel_a'],
          delegationMode: 'parallel_batch',
          parallelSafe: true,
          maxTurns: 12,
          timeoutMs: 120_000,
        },
        {
          agentId: 'parallel_beta',
          name: '并行乙助手',
          role: 'analyst',
          summary: '并行检查数据乙',
          systemPrompt: '你是并行乙子智能体。',
          model: null,
          tools: ['parallel_b'],
          delegationMode: 'parallel_batch',
          parallelSafe: true,
          maxTurns: 12,
          timeoutMs: 120_000,
        },
      ]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const toolExecutions: string[] = []
      tools.register(providerFromTools('parallel-subagent-tools', [
        {
          ...toolDefinition('parallel_a', []),
          handler: async () => {
            toolExecutions.push('parallel_a')
            return result('parallel_a', [], { checked: 'a' })
          },
        },
        {
          ...toolDefinition('parallel_b', []),
          handler: async () => {
            toolExecutions.push('parallel_b')
            return result('parallel_b', [], { checked: 'b' })
          },
        },
      ]))
      const workflow = {
        goal: '并行完成两个彼此独立的只读检查',
        steps: [
          {
            stepId: 'step_parallel_alpha',
            title: '检查数据甲',
            kind: 'agent' as const,
            toolName: 'parallel_alpha',
            ownerAgentId: 'parallel_alpha',
            args: subAgentArgs('检查数据甲', ['甲检查结论']),
            reason: '两个数据源彼此独立，可以并发读取',
            dependsOn: [],
          },
          {
            stepId: 'step_parallel_beta',
            title: '检查数据乙',
            kind: 'agent' as const,
            toolName: 'parallel_beta',
            ownerAgentId: 'parallel_beta',
            args: subAgentArgs('检查数据乙', ['乙检查结论']),
            reason: '两个数据源彼此独立，可以并发读取',
            dependsOn: [],
          },
        ],
      }
      const batchInput = {
        tasks: [
          { taskId: 'task_alpha', agentId: 'parallel_alpha', ...subAgentArgs('检查数据甲', ['甲检查结论']) },
          { taskId: 'task_beta', agentId: 'parallel_beta', ...subAgentArgs('检查数据乙', ['乙检查结论']) },
        ],
      }
      const baseModel = scriptedModel(request => {
        if (request.systemInstructions?.includes('并行甲子智能体')) {
          return hasToolResultNamed(request, 'parallel_a')
            ? { text: '数据甲检查完成。' }
            : { toolCalls: [{ id: 'call_parallel_a', name: 'parallel_a', arguments: '{}' }] }
        }
        if (request.systemInstructions?.includes('并行乙子智能体')) {
          return hasToolResultNamed(request, 'parallel_b')
            ? { text: '数据乙检查完成。' }
            : { toolCalls: [{ id: 'call_parallel_b', name: 'parallel_b', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'delegate_agent_batch')) return { text: '两个只读检查都已汇总。' }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [{
              id: 'call_parallel_batch',
              name: 'delegate_agent_batch',
              arguments: JSON.stringify(batchInput),
            }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_parallel_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const firstChildRequests = deferredSignal()
      let firstChildArrivals = 0
      let activeChildRequests = 0
      let maxActiveChildRequests = 0
      const model: Model = {
        async getResponse(request) {
          const isFirstChildRequest = request.systemInstructions?.includes('并行甲子智能体')
            ? !hasToolResultNamed(request, 'parallel_a')
            : request.systemInstructions?.includes('并行乙子智能体')
              ? !hasToolResultNamed(request, 'parallel_b')
              : false
          if (!isFirstChildRequest) return baseModel.getResponse(request)
          activeChildRequests += 1
          maxActiveChildRequests = Math.max(maxActiveChildRequests, activeChildRequests)
          firstChildArrivals += 1
          if (firstChildArrivals === 2) firstChildRequests.resolve()
          try {
            await firstChildRequests.promise
            return await baseModel.getResponse(request)
          } finally {
            activeChildRequests -= 1
          }
        },
        async *getStreamedResponse(request) {
          yield* baseModel.getStreamedResponse(request)
        },
      }
      const run = await store.createRun(session.id, '并行检查两份数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成并行智能体工作流审批。')

      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(maxActiveChildRequests).toBe(2)
      expect(toolExecutions.sort()).toEqual(['parallel_a', 'parallel_b'])
      expect(completed.state.subAgents).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'parallel_alpha', status: 'completed' }),
        expect.objectContaining({ agentId: 'parallel_beta', status: 'completed' }),
      ]))
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [
          expect.objectContaining({ stepId: 'step_parallel_alpha', status: 'completed' }),
          expect.objectContaining({ stepId: 'step_parallel_beta', status: 'completed' }),
        ],
      })
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({ name: 'delegate_agent_batch' }),
      }))
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        payload: expect.objectContaining({ name: 'delegate_agent_batch', ledgerStatus: 'completed' }),
      }))
      expect((await store.getRunCheckpoint(run.id)).pendingToolCallIds).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rejects parallel subagents with write-capable tools during runtime assembly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-parallel-safety-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行工具安全边界')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'unsafe_parallel_agent',
        name: '不安全并行助手',
        role: 'writer',
        summary: '尝试并行写入',
        systemPrompt: null,
        model: null,
        tools: ['write_layer'],
        delegationMode: 'parallel_batch',
        parallelSafe: true,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(providerFromTools('unsafe-parallel-tool', [{
        ...toolDefinition('write_layer', ['value']),
        isReadOnly: false,
        isDestructive: true,
        handler: async () => result('write', [], { ok: true }),
      }]))
      const run = await store.createRun(session.id, '并行写入数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })

      const failed = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '不应调用模型' })))),
      ).run({ ...runOptions(run, thread.id), runtimeConfig: config })

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.at(-1)).toContain("只能使用只读、非破坏性工具；'write_layer' 不满足约束")
    } finally {
      await removeTempRoot(root)
    }
  })

  it('hands the live conversation to a configured specialist and records ownership lifecycle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-handoff-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Handoff 子智能体测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'specialist',
        name: '专属分析助手',
        role: 'specialist',
        summary: '接管专属分析问题',
        systemPrompt: '你是专属 handoff 子智能体。',
        model: null,
        tools: [],
        delegationMode: 'handoff',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      let rootRequests = 0
      let specialistRequests = 0
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('专属 handoff 子智能体')) {
          specialistRequests += 1
          return { text: '专属分析已经完成。' }
        }
        rootRequests += 1
        return {
          toolCalls: [{
            id: 'call_handoff_specialist',
            name: 'handoff_to_specialist',
            arguments: JSON.stringify(subAgentArgs('完成专属分析', ['专属分析结论'])),
          }],
        }
      })
      const run = await store.createRun(session.id, '把这个问题交给专属分析助手', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(rootRequests).toBe(1)
      expect(specialistRequests).toBe(1)
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'specialist',
        status: 'completed',
        latestMessage: '专属分析已经完成。',
      }))
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          name: 'handoff_to_specialist',
          label: 'Handoff 转交',
          source: 'openai_agents_handoff',
        }),
      }))
      const events = await store.listEvents(run.id)
      expect(events.some(event => (
        event.type === 'subagent.updated'
        && event.payload.delegationMode === 'handoff'
        && event.payload.status === 'completed'
      ))).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK tool timeout and persists a timed-out subagent as failed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-timeout-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子智能体超时测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'slow_analyst',
        name: '慢速分析助手',
        role: 'analyst',
        summary: '测试子智能体超时边界',
        systemPrompt: '你是超时测试子智能体。',
        model: null,
        tools: [],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 25,
      }]
      const workflow = {
        goal: '验证子智能体超时不会无限阻塞主运行',
        steps: [{
          stepId: 'step_slow_agent',
          title: '调用慢速分析助手',
          kind: 'agent' as const,
          toolName: 'slow_analyst',
          ownerAgentId: 'slow_analyst',
          args: subAgentArgs('等待外部数据', ['等待结果']),
          reason: '验证超时和失败状态投影',
          dependsOn: [],
        }],
      }
      const rootModel = scriptedModel(request => hasToolResultNamed(request, 'submit_agent_workflow')
        ? { toolCalls: [{ id: 'call_slow_agent', name: 'slow_analyst', arguments: JSON.stringify(subAgentArgs('等待外部数据', ['等待结果'])) }] }
        : {
            toolCalls: [{
              id: 'call_slow_plan',
              name: 'submit_agent_workflow',
              arguments: JSON.stringify({ workflow }),
            }],
          })
      const model: Model = {
        getResponse: request => request.systemInstructions?.includes('超时测试子智能体')
          ? rejectWhenAborted(request.signal)
          : rootModel.getResponse(request),
        async *getStreamedResponse(request) {
          if (request.systemInstructions?.includes('超时测试子智能体')) {
            await rejectWhenAborted(request.signal)
            return
          }
          yield* rootModel.getStreamedResponse(request)
        },
      }
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const run = await store.createRun(session.id, '请验证子智能体超时', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const liveItems: ConversationItem[] = []
      store.itemBus.subscribe(run.id, item => liveItems.push(item))
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const failed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.join('\n')).toContain('慢速分析助手超过单次调用时限 25ms，已停止。')
      expect(failed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'slow_analyst',
        status: 'failed',
        currentStepId: null,
        latestMessage: '慢速分析助手超过单次调用时限 25ms，已停止。',
      }))
      expect(failed.state.agentWorkflow).toMatchObject({
        status: 'adjusting',
        steps: [expect.objectContaining({ stepId: 'step_slow_agent', status: 'failed' })],
      })
      const subAgentCallUpdates = liveItems.filter(item => (
        item.itemType === 'function_call' && item.name === 'slow_analyst'
      ))
      expect(subAgentCallUpdates.map(item => item.status)).toEqual(['running', 'failed'])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK maxTurns boundary to stop a looping subagent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-max-turns-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子 Agent 轮次上限测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'looping_analyst',
        name: '循环分析助手',
        role: 'analyst',
        summary: '测试子智能体轮次硬边界',
        systemPrompt: '你是轮次上限测试子智能体。',
        model: null,
        tools: ['query_layer'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 2,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      let queryCalls = 0
      tools.register(providerFromTools('subagent-max-turn-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          queryCalls += 1
          return result('query', [], { rows: [] })
        },
      }]))
      const workflow = {
        goal: '验证循环子智能体会被 SDK 轮次边界停止',
        steps: [{
          stepId: 'step_looping_agent',
          title: '调用循环分析助手',
          kind: 'agent' as const,
          toolName: 'looping_analyst',
          ownerAgentId: 'looping_analyst',
          args: subAgentArgs('持续查询', ['查询结论']),
          reason: '验证最大运行轮次边界',
          dependsOn: [],
        }],
      }
      let subAgentCallId = 0
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('轮次上限测试子智能体')) {
          subAgentCallId += 1
          return {
            toolCalls: [{
              id: `looping_query_${subAgentCallId}`,
              name: 'query_layer',
              arguments: '{"query":"继续查询"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_looping_agent', name: 'looping_analyst', arguments: JSON.stringify(subAgentArgs('持续查询', ['查询结论'])) }] }
        }
        return {
          toolCalls: [{
            id: 'call_looping_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const run = await store.createRun(session.id, '请验证子智能体轮次边界', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const failed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(failed.status).toBe('failed')
      expect(queryCalls).toBe(2)
      expect(failed.state.errors.join('\n')).toContain('循环分析助手已达到最大运行轮次 2，为避免循环调用已停止。')
      expect(failed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'looping_analyst',
        status: 'failed',
        currentStepId: null,
        latestMessage: '循环分析助手已达到最大运行轮次 2，为避免循环调用已停止。',
      }))
      expect(failed.state.agentWorkflow).toMatchObject({
        status: 'adjusting',
        steps: [expect.objectContaining({ stepId: 'step_looping_agent', status: 'failed' })],
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('restores previous run valueRefs for continuous thread tool calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-thread-values-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '连续 valueRef 测试')
      const tools = new ToolRegistry()
      tools.register(providerFromTools('thread-value-test', [{
        ...toolDefinition('use_dataset_ref', ['dataset_ref']),
        jsonSchema: {
          type: 'object',
          properties: {
            dataset_ref: {
              type: 'string',
              description: '必须使用 valueRef ID',
              'x-source': 'value_ref',
              'x-value-ref-kinds': ['meteorological_dataset'],
            },
          },
          required: ['dataset_ref'],
        },
        handler: async (_args, context) => {
          const ref = context.resolveValueRef('ref_prior_dataset')
          return result('reuse', [], { reusedKind: ref.kind })
        },
      }]))
      const firstRun = await store.createRun(session.id, '先检查数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await store.updateRunState(firstRun.id, {
        toolValueRefs: [{
          refId: 'ref_prior_dataset',
          kind: 'meteorological_dataset',
          label: '上一轮数据集',
          value: { name: 'rain.nc', relativePath: 'objects/sha256/aa/rain.nc' },
          metadata: {},
          sourceTool: 'meteorological_inspect',
          sourceResultId: 'result_prior',
          createdAt: new Date().toISOString(),
          unit: null,
        }],
      })
      await store.completeRun(firstRun.id, 'completed')
      const secondRun = await store.createRun(session.id, '继续使用上一轮数据集', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let turns = 0
      const model = scriptedModel(request => {
        turns += 1
        if (hasToolResult(request)) return { text: '已经复用上一轮数据集。' }
        return { toolCalls: [{ id: 'call_reuse', name: 'use_dataset_ref', arguments: '{"dataset_ref":"ref_prior_dataset"}' }] }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(secondRun, thread.id))

      expect(completed.status).toBe('completed')
      expect(turns).toBe(2)
      expect(completed.state.toolResults[0]).toMatchObject({
        tool: 'use_dataset_ref',
        status: 'completed',
      })
    } finally {
      await removeTempRoot(root)
    }
  })

})

interface ScriptedResponse {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
}

function scriptedModel(script: (request: ModelRequest) => ScriptedResponse): Model {
  return {
    getRetryAdvice: ({ error }) => error instanceof ReplaySafeTestError
      ? { suggested: true, replaySafety: 'safe', normalized: { isNetworkError: true } }
      : undefined,
    async getResponse(request): Promise<ModelResponse> {
      const response = structuredResponse(script(request), request)
      return { usage: new Usage(), output: outputItems(response, makeIdForResponse()), responseId: makeIdForResponse() }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const response = structuredResponse(script(request), request)
      const responseId = makeIdForResponse()
      yield { type: 'response_started' }
      if (response.reasoning) {
        yield {
          type: 'model',
          event: { choices: [{ index: 0, delta: { reasoning_content: response.reasoning } }] },
        }
      }
      if (response.text) yield { type: 'output_text_delta', delta: response.text }
      yield {
        type: 'response_done',
        response: {
          id: responseId,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: outputItems(response, responseId),
        },
      }
    },
  }
}

class ReplaySafeTestError extends Error {}

function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error('子智能体模型请求缺少 SDK abort signal'))
      return
    }
    const rejectAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error('子智能体模型请求已中止'))
    if (signal.aborted) {
      rejectAbort()
      return
    }
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

let responseSequence = 0
function makeIdForResponse(): string {
  responseSequence += 1
  return `response_${responseSequence}`
}

function outputItems(response: ScriptedResponse, responseId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  if (response.reasoning) output.push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: response.reasoning }] })
  if (response.text) {
    output.push({
      id: responseId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: response.text }],
    })
  }
  for (const call of response.toolCalls ?? []) {
    output.push({
      id: responseId, type: 'function_call', status: 'completed',
      callId: call.id, name: call.name, arguments: call.arguments,
    })
  }
  return output
}

function structuredResponse(response: ScriptedResponse, request: ModelRequest): ScriptedResponse {
  if (!response.text || response.toolCalls?.length || request.outputType === 'text') return response
  const properties = request.outputType.schema.properties
  if ('markdown' in properties) {
    return {
      ...response,
      text: JSON.stringify({ markdown: response.text, summary: response.text, artifactIds: [], warnings: [] }),
    }
  }
  if ('evidence' in properties) {
    return {
      ...response,
      text: JSON.stringify({ status: 'completed', summary: response.text, evidence: [], artifactIds: [], warnings: [], error: null }),
    }
  }
  return response
}

async function executeTextRun(model: Model, tools = new ToolRegistry()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stream-'))
  try {
    const store = createTestPersistenceFacade(root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '模型流测试')
    const run = await store.createRun(session.id, '回答测试问题', {
      threadId: thread.id,
      modelProvider: 'fake',
      runtimeConfigSnapshot: testRuntimeConfig(),
    })
    const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(run, thread.id))
    await store.flushConversationStore()
    return {
      run: structuredClone(completed),
      items: structuredClone(await store.listItems(run.id)),
      transcript: structuredClone(await store.activeTranscript(thread.id)),
    }
  } finally {
    await removeTempRoot(root)
  }
}

function fakeAdapter(model: Model, agentToolSchemaMode: ModelAdapter['agentToolSchemaMode'] = 'strict'): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    contextWindowTokens: 128_000,
    agentToolSchemaMode,
    agentRuntimeCapabilities: {
      structuredOutput: 'json_schema',
      functionTools: true,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['chat', 'stream'],
    createAgentModel: () => model,
    chat: async () => ({ content: '{}' }),
  }
}

function registryWith(adapter: ModelAdapter): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry(testEnv())
  registry.register(adapter)
  return registry
}

function runOptions(run: { id: string; sessionId: string; userQuery: string }, threadId: string) {
  return {
    runId: run.id,
    threadId,
    sessionId: run.sessionId,
    query: run.userQuery,
    provider: 'fake',
    runtimeConfig: testRuntimeConfig(),
  }
}

function requestTexts(request: ModelRequest): string[] {
  if (typeof request.input === 'string') return [request.input]
  return request.input.flatMap(item => {
    if (!('role' in item)) return []
    if (typeof item.content === 'string') return [item.content]
    return item.content.flatMap(part => 'text' in part && typeof part.text === 'string' ? [part.text] : [])
  })
}

function hasToolResult(request: ModelRequest): boolean {
  return Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_result')
}

function hasToolResultNamed(request: ModelRequest, name: string): boolean {
  return Array.isArray(request.input) && request.input.some(item => (
    item.type === 'function_call_result'
    && isRecord(item)
    && item.name === name
  ))
}

function subAgentArgs(objective: string, expectedDeliverables: string[]) {
  return { objective, expectedDeliverables, contextRefs: [], constraints: [] }
}

function approvalProvider(onExecute: () => void): ToolProvider {
  const definition = toolDefinition('sensitive_tool', ['value'])
  return providerFromTools('approval-test-provider', [{
    ...definition,
    jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    handler: async () => {
      onExecute()
      return result('sensitive', [], { ok: true })
    },
  }])
}

function directResponseProvider(): ToolProvider {
  const definition = toolDefinition('deliver_test_response', ['question'])
  return providerFromTools('nowcast-answer-test', [{
    ...definition,
    agentResultMode: 'return_direct',
    handler: async () => ({
      ...result('answer', [], { answer: '预报时段内未检出达到有效阈值的降雨。' }),
      modelOutput: '预报时段内未检出达到有效阈值的降雨。',
    }),
  }])
}

function toolDefinition(name: string, required: string[]): Omit<ToolDef, 'handler'> {
  const labels: Record<string, string> = {
    sensitive_tool: '执行敏感操作',
    write_layer: '写入图层',
    deliver_test_response: '交付测试回答',
    lookup_context: '查询上下文',
    query_layer: '查询图层',
    use_dataset_ref: '使用数据集引用',
    list_meteorological_files: '列出气象文件',
    create_nowcast_sequence: '创建短时临近预报序列',
    meteorological_precipitation_nowcast: '分析短时临近预报降水',
    parallel_a: '并行检查数据甲',
    parallel_b: '并行检查数据乙',
    unstable_inspect: '检查主数据源',
    verified_recovery: '验证恢复数据',
    collect_guidance_data: '采集引导测试数据',
    build_guidance_table: '生成引导测试表格',
  }
  const label = labels[name]
  if (!label) throw new Error(`测试工具 '${name}' 缺少中文展示名称`)
  return {
    name,
    label,
    description: `${name} test tool`,
    prompt: `用于测试 ${name} 工具调用边界。`,
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])),
      required,
    },
  }
}

function workflowStep(stepId: string, title: string, toolName: string, dependsOn: string[] = []) {
  return {
    stepId,
    title,
    kind: 'tool' as const,
    toolName,
    ownerAgentId: 'supervisor',
    args: {},
    reason: title,
    dependsOn,
  }
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let complete!: () => void
  const promise = new Promise<void>(resolve => {
    complete = resolve
  })
  return { promise, resolve: complete }
}

function providerFromTools(id: string, tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id, name: id, version: '1.0.0', author: 'test', language: 'typescript', description: id,
      tools: tools.map(({ handler: _handler, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

function result(name: string, valueRefs: ValueRef[], payload: Record<string, unknown> = {}): ToolResult {
  return {
    message: `${name} completed`, payload, warnings: [], resultId: `result_${name}`, source: 'test', valueRefs,
  }
}

function testEnv(): Env {
  return {
    API_HOST: '127.0.0.1', API_PORT: 0, DATABASE_URL: 'postgres://unused',
    RUNTIME_ROOT: 'runtime', ENABLED_TOOL_PROVIDERS: '',
  }
}

function testRuntimeConfig() {
  const config = defaultRuntimeConfig()
  config.subAgents = []
  return config
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
