// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体工具装配
//
//   文件:       subAgentToolFactory.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  Agent,
  extractAllTextOutput,
  MaxTurnsExceededError,
  ToolTimeoutError,
  invokeFunctionTool,
  type Model,
  type Tool,
} from '@openai/agents'
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
  await options.store.mutateRunState(options.runId, state => {
    const previous = new Map(state.subAgents.map(agent => [agent.agentId, agent]))
    return {
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
    }
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
    const maxTurnsFailureMessage = `${config.name}已达到最大运行轮次 ${config.maxTurns}，为避免循环调用已停止。`
    const maxTurnsFailureOutput = JSON.stringify({
      type: 'geoforge_subagent_failure',
      code: 'max_turns_exceeded',
      message: maxTurnsFailureMessage,
    })
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
      isExecutionEnabled: () => options.coordinator.isExecutionEnabled(),
      isSdkExtensionEnabled: () => false,
      isToolEnabled: toolName => options.coordinator.isToolEnabledForSubAgent(config.agentId, toolName),
      validateToolCall: (toolName, args) => options.coordinator.validateToolCall(toolName, args),
      formatToolFailureForModel: (toolName, message) => options.coordinator.formatToolFailureForModel(toolName, message),
      rejectPreparedToolCall: (toolName, callId, message) => options.coordinator.rejectPreparedToolCall(toolName, callId, message),
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
      isEnabled: () => options.coordinator.isExternalAgentEnabled(config.agentId),
      runOptions: {
        context: subAgentExecutionContext,
        maxTurns: config.maxTurns,
        // Agent-as-tool 会把受支持的 run 错误投影为最终输出；使用明确的内部失败载荷，
        // 再由外层工作流包装器恢复为硬失败，避免主智能体把轮次超限当成成功结果。
        errorHandlers: {
          maxTurns: () => ({ finalOutput: maxTurnsFailureOutput, includeInHistory: true }),
        },
      },
      customOutputExtractor: async output => {
        for (const item of output.newItems) {
          if (item.type === 'message_output_item' && item.content === maxTurnsFailureOutput) continue
          await options.store.appendAgentTranscript(options.runId, config.agentId, {
            type: 'completed_item',
            item: item.toJSON(),
          })
        }
        const outputText = extractAllTextOutput(output.newItems).trim()
        if (!outputText) {
          throw new Error(`子 Agent '${config.agentId}' 未返回文本结果`)
        }
        return outputText
      },
      onStream: async ({ event }) => {
        await options.store.appendAgentTranscript(options.runId, config.agentId, serializeAgentEvent(event))
      },
    })
    const invoke = agentTool.invoke.bind(agentTool)
    const timedAgentTool = {
      ...agentTool,
      timeoutMs: config.timeoutMs,
      timeoutBehavior: 'raise_exception' as const,
      invoke,
    }
    return {
      ...agentTool,
      // 用 SDK 公开的 invokeFunctionTool 在工作流状态包装器内部执行超时。
      // 这样超时会先把子智能体和步骤落为 failed，再作为硬失败返回父运行。
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
          const output = await invokeFunctionTool({
            tool: timedAgentTool,
            runContext,
            input,
            details,
          })
          if (output === maxTurnsFailureOutput) throw new Error(maxTurnsFailureMessage)
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
          const message = subAgentFailureMessage(error, config)
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
          throw new Error(message, { cause: error })
        }
      },
    }
  })
}

function subAgentFailureMessage(
  error: unknown,
  config: AgentRuntimeConfig['subAgents'][number],
): string {
  if (error instanceof MaxTurnsExceededError) {
    return `${config.name}已达到最大运行轮次 ${config.maxTurns}，为避免循环调用已停止。`
  }
  if (error instanceof ToolTimeoutError) {
    return `${config.name}超过单次调用时限 ${config.timeoutMs}ms，已停止。`
  }
  return errorMessage(error)
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
  await options.store.mutateRunState(options.runId, state => {
    const subAgent = state.subAgents.find(candidate => candidate.agentId === agentId)
    if (!subAgent) throw new Error(`子 Agent '${agentId}' 的运行状态不存在`)
    return {
      subAgents: state.subAgents.map(candidate => candidate.agentId === agentId
        ? update(candidate)
        : candidate),
    }
  })
}
