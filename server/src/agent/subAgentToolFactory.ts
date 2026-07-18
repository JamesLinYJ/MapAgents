// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体工具装配
//
//   文件:       subAgentToolFactory.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Agent, type Model, type Tool } from '@openai/agents'
import { z } from 'zod'

import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapter } from '../model/registry.js'
import type { AgentRuntimeConfig, SubAgentState } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import { errorMessage, modelSettings, serializeAgentEvent } from './runtimeSdkProjection.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RunEventSink } from './turnRunner.js'

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/u
const subAgentInvocationSchema = z.object({ input: z.string().min(1) }).strict()

interface SubAgentToolFactoryOptions {
  configs: AgentRuntimeConfig['subAgents']
  selectedModel: string
  rootModel: Model
  reasoning: boolean | undefined
  adapter: ModelAdapter
  toolRegistry: ToolRegistry
  approvalTools: ReadonlySet<string>
  store: AgentRuntimeStore
  runId: string
  eventSink: RunEventSink
  coordinator: ToolExecutionCoordinator
}

// 子智能体继续使用 Agents SDK 原生 Agent-as-tool，但执行前后必须进入同一份
// 智能体工作流状态机，避免“子智能体已完成、工作流步骤仍在等待”的双事实源。
export async function createSubAgentTools(
  options: SubAgentToolFactoryOptions,
): Promise<Tool<AgentsExecutionContext>[]> {
  const previous = new Map(options.store.getRun(options.runId).state.subAgents.map(agent => [agent.agentId, agent]))
  await options.store.updateRunState(options.runId, {
    subAgents: options.configs.map(config => previous.get(config.agentId) ?? ({
      agentId: config.agentId,
      name: config.name,
      role: config.role,
      status: 'pending',
      summary: config.summary,
      stepIds: [],
      tools: config.tools,
      currentStepId: null,
      latestMessage: null,
    })),
  })

  let stateMutation: Promise<void> = Promise.resolve()
  const mutateState = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = stateMutation.then(operation, operation)
    stateMutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  return options.configs.map(config => {
    if (!AGENT_TOOL_NAME.test(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 不能作为工具名`)
    if (options.toolRegistry.get(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 与现有工具重名`)
    const subModelName = config.model ?? options.selectedModel
    const subModel = subModelName === options.selectedModel
      ? options.rootModel
      : options.adapter.createAgentModel!(subModelName)
    const subAgent = new Agent<AgentsExecutionContext>({
      name: config.agentId,
      instructions: config.systemPrompt ?? config.summary,
      handoffDescription: config.summary,
      model: subModel,
      modelSettings: modelSettings(options.reasoning),
      tools: createAgentsTools(options.toolRegistry, options.approvalTools, {
        schemaMode: options.adapter.agentToolSchemaMode,
        allowedToolNames: new Set(config.tools),
      }),
    })
    const subAgentExecutionContext: AgentsExecutionContext = {
      runId: options.runId,
      prepareToolCall: (toolName, args, callId) => options.coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => options.coordinator.executeForSubAgent(
        config.agentId,
        toolName,
        args,
        callId,
      ),
    }
    const agentTool = subAgent.asTool({
      toolName: config.agentId,
      toolDescription: config.summary,
      runOptions: { context: subAgentExecutionContext },
      customOutputExtractor: async output => {
        for (const item of output.newItems) {
          await options.store.appendAgentTranscript(options.runId, config.agentId, {
            type: 'completed_item',
            item: item.toJSON(),
          })
        }
        if (typeof output.finalOutput !== 'string' || !output.finalOutput.trim()) {
          throw new Error(`子 Agent '${config.agentId}' 未返回文本结果`)
        }
        return output.finalOutput
      },
      onStream: async ({ event }) => {
        await options.store.appendAgentTranscript(options.runId, config.agentId, serializeAgentEvent(event))
      },
    })
    const invoke = agentTool.invoke.bind(agentTool)
    return {
      ...agentTool,
      invoke: async (runContext, input, details) => {
        const callId = details?.toolCall?.callId
        if (!callId) throw new Error(`子 Agent '${config.agentId}' 缺少 callId`)
        const workflowStepId = await options.coordinator.beginExternalAgentStep(
          config.agentId,
          parseSubAgentInvocation(config.agentId, input),
          callId,
        )
        try {
          await mutateState(() => updateSubAgentState(options, config.agentId, current => ({
            ...current,
            status: 'running',
            stepIds: workflowStepId && !current.stepIds.includes(workflowStepId)
              ? [...current.stepIds, workflowStepId]
              : current.stepIds,
            currentStepId: workflowStepId,
            latestMessage: '子智能体正在执行',
          })))
          options.eventSink.emit('subagent.updated', `${config.name} 正在执行`, {
            agentId: config.agentId,
            status: 'running',
            stepId: workflowStepId,
          })
          const output = await invoke(runContext, input, details)
          await options.coordinator.completeExternalAgentStep(callId, `${config.name} 已完成`)
          await mutateState(() => updateSubAgentState(options, config.agentId, current => ({
            ...current,
            status: 'completed',
            currentStepId: null,
            latestMessage: '子智能体已返回结果',
          })))
          options.eventSink.emit('subagent.updated', `${config.name} 已完成`, {
            agentId: config.agentId,
            status: 'completed',
            stepId: workflowStepId,
          })
          return output
        } catch (error) {
          const message = errorMessage(error)
          await options.coordinator.failExternalAgentStep(callId, message)
          await mutateState(() => updateSubAgentState(options, config.agentId, current => ({
            ...current,
            status: 'failed',
            currentStepId: null,
            latestMessage: message,
          })))
          options.eventSink.emit('subagent.updated', `${config.name} 执行失败`, {
            agentId: config.agentId,
            status: 'failed',
            stepId: workflowStepId,
          })
          throw error
        }
      },
    }
  })
}

function parseSubAgentInvocation(agentId: string, input: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error(`子 Agent '${agentId}' 调用参数不是有效 JSON`)
  }
  const result = subAgentInvocationSchema.safeParse(parsed)
  if (!result.success) throw new Error(`子 Agent '${agentId}' 调用参数不符合 input 契约`)
  return result.data
}

async function updateSubAgentState(
  options: Pick<SubAgentToolFactoryOptions, 'store' | 'runId'>,
  agentId: string,
  update: (state: SubAgentState) => SubAgentState,
): Promise<void> {
  const run = options.store.getRun(options.runId)
  const subAgent = run.state.subAgents.find(candidate => candidate.agentId === agentId)
  if (!subAgent) throw new Error(`子 Agent '${agentId}' 的运行状态不存在`)
  await options.store.updateRunState(options.runId, {
    subAgents: run.state.subAgents.map(candidate => candidate.agentId === agentId
      ? update(candidate)
      : candidate),
  })
}
