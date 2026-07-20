// +-------------------------------------------------------------------------
//
//   地理智能平台 - 只读并行子智能体批处理工具
//
//   文件:       parallelSubAgentToolFactory.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import PQueue from 'p-queue'
import {
  RunContext,
  Runner,
  tool,
  type Tool,
} from '@openai/agents'
import {
  agentBatchInvocationSchema,
  agentBatchDeliverySchema,
  type AgentBatchTask,
  type AgentBatchTaskResult,
  type RuntimeSubAgentConfig,
  type SubAgentInvocation,
} from '@geo-agent-platform/shared-types/runtime'

import type { AgentsExecutionContext } from './agentsToolBridge.js'
import {
  assertSubAgentDeliveryArtifacts,
  createSubAgentDeliveryAgent,
  createSubAgentExecutionContext,
  formatSubAgentInput,
  parseSubAgentDelivery,
  subAgentErrorHandlers,
  subAgentFailureMessage,
  SubAgentStateController,
  type SubAgentRuntimeDependencies,
} from './subAgentRuntimeSupport.js'

export const PARALLEL_SUBAGENT_TOOL_NAME = 'delegate_agent_batch'

interface ParallelSubAgentToolFactoryOptions extends SubAgentRuntimeDependencies {
  configs: RuntimeSubAgentConfig[]
  maxParallelSubAgents: number
  signal: AbortSignal
  stateController: SubAgentStateController
}

interface PreparedParallelTask {
  task: AgentBatchTask
  config: RuntimeSubAgentConfig
  callId: string
  stepId: string | null
}

export function createParallelSubAgentTool(
  options: ParallelSubAgentToolFactoryOptions,
): Tool<AgentsExecutionContext> | null {
  const configs = options.configs.filter(config => config.delegationMode === 'parallel_batch')
  if (!configs.length) return null
  if (options.toolRegistry.get(PARALLEL_SUBAGENT_TOOL_NAME)) {
    throw new Error(`并行子智能体工具名 '${PARALLEL_SUBAGENT_TOOL_NAME}' 与现有工具重名`)
  }
  const byAgentId = new Map(configs.map(config => [config.agentId, config]))
  for (const config of configs) assertParallelAgentSafety(config, options)

  const agents = new Map(configs.map(config => [config.agentId, {
    agent: createSubAgentDeliveryAgent(config, options, new Set()),
    context: createSubAgentExecutionContext(config, options),
  }]))

  return tool({
    name: PARALLEL_SUBAGENT_TOOL_NAME,
    description: [
      '并行执行多个彼此独立、只读且无需审批的子智能体任务。',
      '每个 agentId 在同一批次最多出现一次；任务必须逐项对应已批准工作流中当前可运行的 agent 步骤。',
      '返回每项任务的结构化成功或失败结果，禁止把失败项当成成功结论。',
    ].join(' '),
    parameters: agentBatchInvocationSchema,
    strict: true,
    isEnabled: () => configs.some(config => options.coordinator.isExternalAgentEnabled(config.agentId)),
    needsApproval: async (_runContext, input, callId) => {
      if (!callId) throw new Error('并行子智能体调用缺少 callId')
      const invocation = agentBatchInvocationSchema.parse(input)
      await options.coordinator.prepareExternalAgentCall(
        PARALLEL_SUBAGENT_TOOL_NAME,
        '并行子智能体任务',
        invocation,
        callId,
      )
      return false
    },
    execute: async (input, _runContext, details) => {
      const callId = details?.toolCall?.callId
      if (!callId) throw new Error('并行子智能体调用缺少 callId')
      const invocation = agentBatchInvocationSchema.parse(input)
      try {
        return await executeParallelBatch(invocation.tasks, callId, configs, byAgentId, agents, options)
      } finally {
        await options.coordinator.settlePreparedExternalAgentCall(callId)
      }
    },
  })
}

async function executeParallelBatch(
  tasks: AgentBatchTask[],
  callId: string,
  configs: RuntimeSubAgentConfig[],
  byAgentId: ReadonlyMap<string, RuntimeSubAgentConfig>,
  agents: ReadonlyMap<string, {
    agent: ReturnType<typeof createSubAgentDeliveryAgent>
    context: AgentsExecutionContext
  }>,
  options: ParallelSubAgentToolFactoryOptions,
): Promise<string> {
  assertBatchIdentity(tasks)
  if (tasks.length > options.maxParallelSubAgents) {
    throw new Error(`并行子智能体任务数 ${tasks.length} 超过配置上限 ${options.maxParallelSubAgents}`)
  }

  const prepared: PreparedParallelTask[] = []
  try {
    for (const task of tasks) {
      const config = byAgentId.get(task.agentId)
      if (!config) throw new Error(`并行批次引用了未配置或非 parallel_batch 的子智能体 '${task.agentId}'`)
      const taskCallId = `${callId}:${task.taskId}`
      const stepId = await options.stateController.start(config, invocationForTask(task), taskCallId)
      prepared.push({ task, config, callId: taskCallId, stepId })
    }
  } catch (error) {
    const firstConfig = configs.at(0)
    if (!firstConfig) throw new Error('并行子智能体配置在批次准备期间丢失', { cause: error })
    const message = `并行子智能体批次准备失败：${subAgentFailureMessage(error, firstConfig)}`
    await Promise.all(prepared.map(task => options.stateController.fail(
      task.config,
      task.callId,
      task.stepId,
      message,
    )))
    throw new Error(message, { cause: error })
  }

  const queue = new PQueue({ concurrency: options.maxParallelSubAgents })
  const results = await Promise.all(prepared.map(task => queue.add(
    () => executeParallelTask(task, agents, options),
  )))
  if (results.some(result => result === undefined)) {
    throw new Error('并行子智能体队列未返回完整任务结果')
  }
  const taskResults = results.filter((result): result is AgentBatchTaskResult => result !== undefined)
  const completed = taskResults.filter(task => task.status === 'completed').length
  const status = completed === taskResults.length
    ? 'completed' as const
    : completed === 0
      ? 'failed' as const
      : 'partial_failure' as const
  return JSON.stringify(agentBatchDeliverySchema.parse({ status, tasks: taskResults }))
}

async function executeParallelTask(
  prepared: PreparedParallelTask,
  agents: ReadonlyMap<string, {
    agent: ReturnType<typeof createSubAgentDeliveryAgent>
    context: AgentsExecutionContext
  }>,
  options: ParallelSubAgentToolFactoryOptions,
): Promise<AgentBatchTaskResult> {
  const startedAt = Date.now()
  const runtime = agents.get(prepared.config.agentId)
  if (!runtime) throw new Error(`子智能体 '${prepared.config.agentId}' 未完成并行装配`)
  const timeoutSignal = AbortSignal.timeout(prepared.config.timeoutMs)
  const signal = AbortSignal.any([options.signal, timeoutSignal])
  const runner = new Runner({
    tracingDisabled: !options.agentTracing,
    traceIncludeSensitiveData: false,
    workflowName: 'GeoForge Parallel SubAgent',
    groupId: options.threadId,
    traceMetadata: {
      runId: options.runId,
      threadId: options.threadId,
      agentId: prepared.config.agentId,
      delegationMode: 'parallel_batch',
    },
    toolNotFoundBehavior: 'return_error_to_model',
  })
  try {
    const result = await runner.run(runtime.agent, formatSubAgentInput(invocationForTask(prepared.task)), {
      context: new RunContext(runtime.context),
      maxTurns: prepared.config.maxTurns,
      errorHandlers: subAgentErrorHandlers(prepared.config),
      signal,
    })
    for (const item of result.newItems) {
      await options.store.appendAgentTranscript(options.runId, prepared.config.agentId, {
        type: 'completed_item',
        item: item.toJSON(),
      })
    }
    const delivery = parseSubAgentDelivery(prepared.config.agentId, result.finalOutput)
    assertSubAgentDeliveryArtifacts(delivery, options)
    await options.stateController.complete(prepared.config, prepared.callId, prepared.stepId, delivery)
    return {
      taskId: prepared.task.taskId,
      agentId: prepared.config.agentId,
      status: 'completed',
      delivery,
      error: null,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = timeoutSignal.aborted && !options.signal.aborted
      ? `${prepared.config.name}超过单次调用时限 ${prepared.config.timeoutMs}ms，已停止。`
      : subAgentFailureMessage(error, prepared.config)
    await options.store.appendAgentTranscript(options.runId, prepared.config.agentId, {
      type: 'parallel_task_failed',
      taskId: prepared.task.taskId,
      error: message,
    })
    await options.stateController.fail(prepared.config, prepared.callId, prepared.stepId, message)
    return {
      taskId: prepared.task.taskId,
      agentId: prepared.config.agentId,
      status: 'failed',
      delivery: null,
      error: message,
      durationMs: Date.now() - startedAt,
    }
  }
}

function assertParallelAgentSafety(
  config: RuntimeSubAgentConfig,
  options: Pick<ParallelSubAgentToolFactoryOptions, 'toolRegistry' | 'approvalTools'>,
): void {
  if (!config.parallelSafe) {
    throw new Error(`子智能体 '${config.agentId}' 使用 parallel_batch 时必须显式声明 parallelSafe=true`)
  }
  for (const toolName of config.tools) {
    const definition = options.toolRegistry.get(toolName)
    if (!definition) throw new Error(`并行子智能体 '${config.agentId}' 引用了未知工具 '${toolName}'`)
    if (!definition.isReadOnly || definition.isDestructive) {
      throw new Error(`并行子智能体 '${config.agentId}' 只能使用只读、非破坏性工具；'${toolName}' 不满足约束`)
    }
    if (definition.requiresApproval === true || options.approvalTools.has(toolName)) {
      throw new Error(`并行子智能体 '${config.agentId}' 不能使用需要审批的工具 '${toolName}'`)
    }
  }
}

function assertBatchIdentity(tasks: AgentBatchTask[]): void {
  const taskIds = new Set<string>()
  const agentIds = new Set<string>()
  for (const task of tasks) {
    if (taskIds.has(task.taskId)) throw new Error(`并行批次 taskId '${task.taskId}' 重复`)
    if (agentIds.has(task.agentId)) throw new Error(`并行批次 agentId '${task.agentId}' 重复`)
    taskIds.add(task.taskId)
    agentIds.add(task.agentId)
  }
}

function invocationForTask(task: AgentBatchTask): SubAgentInvocation {
  return {
    objective: task.objective,
    expectedDeliverables: task.expectedDeliverables,
    contextRefs: task.contextRefs,
    constraints: task.constraints,
  }
}
