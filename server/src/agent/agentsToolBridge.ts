// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接
//
//   文件:       agentsToolBridge.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { ToolGuardrailFunctionOutputFactory, tool, type RunContext, type Tool } from '@openai/agents'
import {
  agentToolOutputMetadataSchema,
  type AgentToolOutputMetadata,
} from '@geo-agent-platform/shared-types/runtime'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolDef } from '../framework/types.js'
import { enrichValueRefDescriptions, ensureToolSchemas, isRecord, parametersForAgentsSdk, parametersForCompatibleAgentsSdk, stripNullObjectValues, valueRefRules } from '../framework/schema.js'
import type { AgentToolSchemaMode } from '../model/registry.js'
import { toolExecutionLane, type ToolExecutionLane } from './runToolConcurrencyGate.js'

export interface AgentsExecutionContext {
  runId: string
  isExecutionEnabled(): boolean
  isSdkExtensionEnabled(): boolean
  isToolEnabled(toolName: string): boolean
  validateToolCall(toolName: string, args: Record<string, unknown>): string | null
  formatToolFailureForModel(toolName: string, message: string): string
  rejectPreparedToolCall(toolName: string, callId: string, message: string): Promise<void>
  prepareToolCall(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, callId: string): Promise<string>
  runToolExecution<T>(lane: ToolExecutionLane, operation: () => Promise<T>): Promise<T>
  toolOutputMetadata(callId: string): AgentToolOutputMetadata
}

export interface CreateAgentsToolsOptions {
  schemaMode: AgentToolSchemaMode
  allowedToolNames?: ReadonlySet<string>
  executionScope?: AgentsToolExecutionScope
}

export interface AgentsToolExecutionScope {
  isToolEnabled(toolName: string): boolean
  validateToolCall(toolName: string, args: Record<string, unknown>): string | null
  formatToolFailureForModel(toolName: string, message: string): string
  rejectPreparedToolCall(toolName: string, callId: string, message: string): Promise<void>
  prepareToolCall(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, callId: string): Promise<string>
  runToolExecution<T>(lane: ToolExecutionLane, operation: () => Promise<T>): Promise<T>
  toolOutputMetadata(callId: string): AgentToolOutputMetadata
}

export function createAgentsTools(
  registry: ToolRegistry,
  approvalTools: ReadonlySet<string>,
  options: CreateAgentsToolsOptions,
): Tool<AgentsExecutionContext>[] {
  const definitions = options.allowedToolNames
    ? [...options.allowedToolNames].map(name => {
      const definition = registry.get(name)
      if (!definition) throw new Error(`Agent 工具 allowlist 包含未知工具 '${name}'`)
      if (!supportsAgentExecution(definition)) {
        throw new Error(`Agent 工具 allowlist 包含非 Agent 执行表面工具 '${name}'`)
      }
      return definition
    })
    : registry.list().filter(supportsAgentExecution)

  return definitions.map(definition => {
    const { jsonSchema } = ensureToolSchemas(definition)
    const enrichedSchema = enrichValueRefDescriptions(jsonSchema)
    const description = describeToolForAgent(definition, jsonSchema)
    const normalizeArguments = (input: unknown): Record<string, unknown> => {
      const args = requireArguments(definition.name, input)
      return options.schemaMode === 'strict' ? stripNullObjectValues(args) : args
    }
    const scope = (runContext?: RunContext<unknown>): AgentsToolExecutionScope => (
      options.executionScope ?? requireContext(runContext)
    )
    const isEnabled = ({ runContext }: { runContext: RunContext<AgentsExecutionContext> }): boolean => (
      scope(runContext).isToolEnabled(definition.name)
    )
    const needsApproval = async (runContext: RunContext, input: unknown, callId?: string): Promise<boolean> => {
      const execution = scope(runContext)
      const args = normalizeArguments(input)
      if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
      await execution.prepareToolCall(definition.name, args, callId)
      return definition.requiresApproval === true || definition.isDestructive || approvalTools.has(definition.name)
    }
    const execute = async (
      input: unknown,
      runContext?: RunContext<AgentsExecutionContext>,
      details?: { toolCall?: { callId?: string } },
    ): Promise<string> => {
      const execution = scope(runContext)
      const args = normalizeArguments(input)
      const callId = details?.toolCall?.callId
      if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
      await execution.prepareToolCall(definition.name, args, callId)
      const lane = toolExecutionLane(definition, approvalTools.has(definition.name))
      return execution.runToolExecution(
        lane,
        () => execution.executeTool(definition.name, args, callId),
      )
    }
    const customDataExtractor = ({ runContext, toolCall }: {
      runContext: RunContext<AgentsExecutionContext>
      toolCall: { callId: string }
    }): AgentToolOutputMetadata => agentToolOutputMetadataSchema.parse(
      scope(runContext).toolOutputMetadata(toolCall.callId),
    )
    const errorFunction = (runContext: RunContext, error: unknown): string => {
      const message = error instanceof Error ? error.message : String(error)
      // 策略性错误（plan mode、审批拒绝等）应传播而非让模型重试
      if (/计划模式|禁止执行|无权|未授权/.test(message)) {
        throw error instanceof Error ? error : new Error(message)
      }
      return scope(runContext).formatToolFailureForModel(definition.name, message)
    }
    const workflowGuardrails = AGENT_WORKFLOW_DEFINITION_TOOLS.has(definition.name)
      ? [{
          name: 'agent_workflow_definition_contract',
          run: async ({ context, toolCall }: { context: RunContext<AgentsExecutionContext>; toolCall: { arguments: string; callId: string } }) => {
            const runtime = scope(context)
            const parsed: unknown = JSON.parse(toolCall.arguments)
            const args = normalizeArguments(parsed)
            const rejection = runtime.validateToolCall(definition.name, args)
            if (!rejection) return ToolGuardrailFunctionOutputFactory.allow({ toolName: definition.name })
            await runtime.rejectPreparedToolCall(definition.name, toolCall.callId, rejection)
            return ToolGuardrailFunctionOutputFactory.rejectContent(rejection, { toolName: definition.name })
          },
        }]
      : []

    if (options.schemaMode === 'compatible') {
      const parameters = parametersForCompatibleAgentsSdk(enrichedSchema)
      return tool<typeof parameters, AgentsExecutionContext>({
        name: definition.name,
        description,
        parameters,
        strict: false,
        errorFunction,
        needsApproval,
        isEnabled,
        inputGuardrails: workflowGuardrails,
        execute,
        customDataExtractor,
      })
    }

    const parameters = parametersForAgentsSdk(enrichedSchema)
    return tool<typeof parameters, AgentsExecutionContext>({
      name: definition.name,
      description,
      parameters,
      strict: true,
      errorFunction,
      needsApproval,
      isEnabled,
      inputGuardrails: workflowGuardrails,
      execute,
      customDataExtractor,
    })
  })
}

function supportsAgentExecution(definition: ToolDef): boolean {
  return definition.executionSurfaces?.includes('agent') ?? true
}

// Agent 看到的是 Chat Completions 函数 schema，而不是 DebugPage 的参数面板。
// 因此 valueRef kind 约束必须写进模型可读描述里，避免把相邻工具产生的 ref 混用。
function describeToolForAgent(definition: ToolDef, jsonSchema: Record<string, unknown>): string {
  const parts = [definition.description, `工具使用说明：\n${definition.prompt.trim()}`]
  const rules = valueRefRules(enrichValueRefDescriptions(jsonSchema))
  if (rules.length) {
    parts.push(`ValueRef 参数规则：${rules.join('；')}。调用前必须确认 refId 的 kind 匹配，不能用其它 kind 的 valueRef 代替。`)
  }
  return parts.join('\n\n')
}

function requireContext(runContext?: RunContext<unknown>): AgentsExecutionContext {
  const context = runContext?.context
  if (!isRecord(context)
    || typeof context.runId !== 'string'
    || typeof context.isExecutionEnabled !== 'function'
    || typeof context.isSdkExtensionEnabled !== 'function'
    || typeof context.isToolEnabled !== 'function'
    || typeof context.validateToolCall !== 'function'
    || typeof context.formatToolFailureForModel !== 'function'
    || typeof context.rejectPreparedToolCall !== 'function'
    || typeof context.prepareToolCall !== 'function'
    || typeof context.executeTool !== 'function'
    || typeof context.runToolExecution !== 'function'
    || typeof context.toolOutputMetadata !== 'function') {
    throw new Error('Agents SDK 工具缺少运行上下文')
  }
  return context as unknown as AgentsExecutionContext
}

const AGENT_WORKFLOW_DEFINITION_TOOLS = new Set([
  'submit_agent_workflow',
  'revise_agent_workflow',
])

function requireArguments(toolName: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`工具 '${toolName}' 参数必须为 JSON object`)
  return input
}
