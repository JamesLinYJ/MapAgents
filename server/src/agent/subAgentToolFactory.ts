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
  invokeFunctionTool,
  type Tool,
} from '@openai/agents'
import {
  subAgentInvocationSchema,
} from '@geo-agent-platform/shared-types/runtime'

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { serializeAgentEvent } from './runtimeSdkProjection.js'
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

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/u

interface SubAgentToolFactoryOptions extends SubAgentRuntimeDependencies {
  configs: AgentRuntimeConfig['subAgents']
  stateController?: SubAgentStateController
}

// 子智能体继续使用 Agents SDK 原生 Agent-as-tool，但执行前后必须进入同一份
// 智能体工作流状态机，避免“子智能体已完成、工作流步骤仍在等待”的双事实源。
export async function createSubAgentTools(
  options: SubAgentToolFactoryOptions,
): Promise<Tool<AgentsExecutionContext>[]> {
  const stateController = options.stateController ?? new SubAgentStateController(options)
  if (!options.stateController) await stateController.initialize(options.configs)

  return options.configs.filter(config => config.delegationMode === 'as_tool').map(config => {
    if (!AGENT_TOOL_NAME.test(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 不能作为工具名`)
    if (options.toolRegistry.get(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 与现有工具重名`)
    const subAgent = createSubAgentDeliveryAgent(config, options)
    const subAgentExecutionContext = createSubAgentExecutionContext(config, options)
    const agentTool = subAgent.asTool({
      toolName: config.agentId,
      toolDescription: config.summary,
      parameters: subAgentInvocationSchema,
      includeInputSchema: true,
      inputBuilder: ({ params }) => formatSubAgentInput(params),
      needsApproval: async (_runContext, input, callId) => {
        if (!callId) throw new Error(`子 Agent '${config.agentId}' 缺少 callId`)
        const invocation = subAgentInvocationSchema.parse(input)
        await options.coordinator.prepareExternalAgentCall(
          config.agentId,
          config.name,
          invocation,
          callId,
        )
        return false
      },
      isEnabled: () => options.coordinator.isExternalAgentEnabled(config.agentId),
      runOptions: {
        context: subAgentExecutionContext,
        maxTurns: config.maxTurns,
        errorHandlers: subAgentErrorHandlers(config),
      },
      customOutputExtractor: async output => {
        for (const item of output.newItems) {
          await options.store.appendAgentTranscript(options.runId, config.agentId, {
            type: 'completed_item',
            item: item.toJSON(),
          })
        }
        return JSON.stringify(output.finalOutput)
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
        const invocation = parseSubAgentInvocation(config.agentId, input)
        const workflowStepId = await stateController.start(config, invocation, callId)
        try {
          const output = await invokeFunctionTool({
            tool: timedAgentTool,
            runContext,
            input,
            details,
          })
          if (typeof output !== 'string') {
            throw new Error(`子 Agent '${config.agentId}' 返回了非文本工具结果`)
          }
          const delivery = parseSubAgentDelivery(config.agentId, output)
          assertSubAgentDeliveryArtifacts(delivery, options)
          await stateController.complete(config, callId, workflowStepId, delivery)
          return JSON.stringify(delivery)
        } catch (error) {
          const message = subAgentFailureMessage(error, config)
          await stateController.fail(config, callId, workflowStepId, message)
          throw new Error(message, { cause: error })
        }
      },
    }
  })
}

function parseSubAgentInvocation(agentId: string, input: string) {
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
