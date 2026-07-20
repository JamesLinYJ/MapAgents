// +-------------------------------------------------------------------------
//
//   地理智能平台 - Handoff 子智能体装配
//
//   文件:       handoffAgentFactory.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  Agent,
  handoff,
  type Handoff,
} from '@openai/agents'
import {
  subAgentInvocationSchema,
  supervisorDeliverySchema,
  type RuntimeSubAgentConfig,
} from '@geo-agent-platform/shared-types/runtime'

import { createAgentsTools, type AgentsExecutionContext, type AgentsToolExecutionScope } from './agentsToolBridge.js'
import { modelSettings } from './runtimeSdkProjection.js'
import {
  resolveSubAgentModel,
  SubAgentStateController,
  type SubAgentRuntimeDependencies,
} from './subAgentRuntimeSupport.js'

const AGENT_NAME = /^[a-zA-Z0-9_-]+$/u

export interface HandoffAgentIntegration {
  handoffs: Handoff<AgentsExecutionContext, typeof supervisorDeliverySchema>[]
  agentIds: ReadonlySet<string>
  complete(agentId: string, summary: string): Promise<void>
  fail(agentId: string, message: string): Promise<void>
}

interface HandoffAgentFactoryOptions extends SubAgentRuntimeDependencies {
  configs: RuntimeSubAgentConfig[]
  stateController: SubAgentStateController
}

export function createHandoffAgents(options: HandoffAgentFactoryOptions): HandoffAgentIntegration {
  const configs = options.configs.filter(config => config.delegationMode === 'handoff')
  const byAgentId = new Map(configs.map(config => [config.agentId, config]))
  const handoffs = configs.map(config => {
    if (!AGENT_NAME.test(config.agentId)) throw new Error(`Handoff Agent id '${config.agentId}' 不是合法工具名`)
    const toolName = `handoff_to_${config.agentId}`
    if (options.toolRegistry.get(toolName)) throw new Error(`Handoff 工具名 '${toolName}' 与现有工具重名`)
    const executionScope: AgentsToolExecutionScope = {
      isToolEnabled: name => options.coordinator.isToolEnabledForHandoff(config.agentId, name),
      validateToolCall: (name, args) => options.coordinator.validateToolCall(name, args),
      formatToolFailureForModel: (name, message) => options.coordinator.formatToolFailureForModel(name, message),
      rejectPreparedToolCall: (name, callId, message) => options.coordinator.rejectPreparedToolCall(name, callId, message),
      prepareToolCall: (name, args, callId) => options.coordinator.prepare(name, args, callId),
      executeTool: (name, args, callId) => options.coordinator.executeForHandoff(
        config.agentId,
        name,
        args,
        callId,
      ),
    }
    const agent = new Agent<AgentsExecutionContext, typeof supervisorDeliverySchema>({
      name: config.agentId,
      instructions: [
        config.systemPrompt ?? config.summary,
        '你已经通过 handoff 接管当前对话。请完成任务并直接交付 supervisorDelivery outputType；不要再把任务退回给主智能体。',
        'artifactIds 只能填写工具结果 artifacts[].artifactId 中以 artifact_ 开头的真实平台 ID；不能填写 valueRefs[].refId。没有 Artifact 时返回空数组。',
      ].join('\n\n'),
      handoffDescription: config.summary,
      model: resolveSubAgentModel(config, options),
      modelSettings: modelSettings(options.reasoning),
      outputType: supervisorDeliverySchema,
      tools: createAgentsTools(options.toolRegistry, options.approvalTools, {
        schemaMode: options.adapter.agentToolSchemaMode,
        allowedToolNames: new Set(config.tools),
        executionScope,
      }),
    })
    return handoff(agent, {
      toolNameOverride: toolName,
      toolDescriptionOverride: `把当前对话处理权转交给 ${config.name}。${config.summary}`,
      inputType: subAgentInvocationSchema,
      isEnabled: () => options.coordinator.isHandoffEnabled(config.agentId),
      onHandoff: async (_context, input) => {
        subAgentInvocationSchema.parse(input)
        await options.stateController.startHandoff(config)
      },
    })
  })

  return {
    handoffs,
    agentIds: new Set(configs.map(config => config.agentId)),
    async complete(agentId, summary) {
      const config = byAgentId.get(agentId)
      if (!config) return
      await options.stateController.completeHandoff(config, summary)
    },
    async fail(agentId, message) {
      const config = byAgentId.get(agentId)
      if (!config) return
      await options.stateController.failHandoff(config, message)
    },
  }
}
