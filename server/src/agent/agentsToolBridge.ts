// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接
//
//   文件:       agentsToolBridge.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { tool, type RunContext, type Tool } from '@openai/agents'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolDef } from '../framework/types.js'
import { enrichValueRefDescriptions, ensureToolSchemas, isRecord, parametersForAgentsSdk, parametersForCompatibleAgentsSdk, stripNullObjectValues, valueRefRules } from '../framework/schema.js'
import type { AgentToolSchemaMode } from '../model/registry.js'

export interface AgentsExecutionContext {
  runId: string
  prepareToolCall(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, callId: string): Promise<string>
}

export interface CreateAgentsToolsOptions {
  schemaMode: AgentToolSchemaMode
  allowedToolNames?: ReadonlySet<string>
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
    const needsApproval = async (runContext: RunContext, input: unknown, callId?: string): Promise<boolean> => {
      const context = requireContext(runContext)
      const args = normalizeArguments(input)
      if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
      await context.prepareToolCall(definition.name, args, callId)
      return definition.requiresApproval === true || definition.isDestructive || approvalTools.has(definition.name)
    }
    const execute = async (
      input: unknown,
      runContext?: RunContext<AgentsExecutionContext>,
      details?: { toolCall?: { callId?: string } },
    ): Promise<string> => {
      const context = requireContext(runContext)
      const args = normalizeArguments(input)
      const callId = details?.toolCall?.callId
      if (!callId) throw new Error(`工具 '${definition.name}' 缺少 callId`)
      await context.prepareToolCall(definition.name, args, callId)
      return context.executeTool(definition.name, args, callId)
    }
    const errorFunction = (_context: RunContext, error: unknown): string => {
      const message = error instanceof Error ? error.message : String(error)
      // 策略性错误（plan mode、审批拒绝等）应传播而非让模型重试
      if (/计划模式|禁止执行|无权|未授权/.test(message)) {
        throw error instanceof Error ? error : new Error(message)
      }
      return `工具调用失败：${message}。请检查参数类型和必需字段后重试。`
    }

    if (options.schemaMode === 'compatible') {
      const parameters = parametersForCompatibleAgentsSdk(enrichedSchema)
      return tool<typeof parameters, AgentsExecutionContext>({
        name: definition.name,
        description,
        parameters,
        strict: false,
        errorFunction,
        needsApproval,
        execute,
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
      execute,
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
    || typeof context.prepareToolCall !== 'function'
    || typeof context.executeTool !== 'function') {
    throw new Error('Agents SDK 工具缺少运行上下文')
  }
  return context as unknown as AgentsExecutionContext
}

function requireArguments(toolName: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`工具 '${toolName}' 参数必须为 JSON object`)
  return input
}
