// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求工具计划快照
//
//   文件:       AgentToolPlan.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest, Tool } from '@openai/agents'
import {
  agentToolPlanSnapshotSchema,
  type AgentToolPlanEntry,
  type AgentToolPlanSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'

import type { ToolDef } from '../../framework/types.js'
import { agentContextDigest } from './agentContextDigest.js'

export type AgentToolPlanKind = AgentToolPlanEntry['kind']

export interface AgentToolPlanSource {
  name: string
  kind: AgentToolPlanKind
  providerId: string | null
  requiresApproval: boolean
  readOnly: boolean | null
  destructive: boolean | null
}

/**
 * 以 SDK 即将交给 Model 的序列化定义为事实源。来源索引只补充
 * handler/provider/审批语义；实际模型可见 schema 与定义必须来自同一个
 * ModelRequest，不允许事后重新扫描 ToolRegistry 猜测。
 */
export function createAgentToolPlan(input: {
  request: Pick<ModelRequest, 'tools' | 'handoffs'>
  sources: readonly AgentToolPlanSource[]
}): AgentToolPlanSnapshot {
  const sources = indexSources(input.sources)
  const entries = [
    ...input.request.tools.map(tool => entryForDefinition(
      tool.name,
      tool,
      schemaForTool(tool),
      sources,
    )),
    ...input.request.handoffs.map(handoff => entryForDefinition(
      handoff.toolName,
      { type: 'handoff', ...handoff },
      handoff.inputJsonSchema,
      sources,
    )),
  ].sort((left, right) => left.name.localeCompare(right.name))
  const catalogDigest = agentContextDigest(entries)
  return deepFreeze(agentToolPlanSnapshotSchema.parse({ entries, catalogDigest }))
}

export function platformToolPlanSource(definition: ToolDef): AgentToolPlanSource {
  return {
    name: definition.name,
    kind: 'platform',
    providerId: definition.providerId ?? null,
    requiresApproval: definition.requiresApproval === true || definition.isDestructive,
    readOnly: definition.isReadOnly,
    destructive: definition.isDestructive,
  }
}

export function sdkToolPlanSource<TContext>(input: {
  tool: Tool<TContext>
  kind: Exclude<AgentToolPlanKind, 'platform' | 'handoff'>
  providerId?: string | null
  requiresApproval?: boolean
  readOnly?: boolean | null
  destructive?: boolean | null
}): AgentToolPlanSource {
  return {
    name: input.tool.name,
    kind: input.kind,
    providerId: input.providerId ?? null,
    requiresApproval: input.requiresApproval ?? false,
    readOnly: input.readOnly ?? null,
    destructive: input.destructive ?? null,
  }
}

export function handoffToolPlanSource(input: {
  toolName: string
  agentId: string
}): AgentToolPlanSource {
  return {
    name: input.toolName,
    kind: 'handoff',
    providerId: input.agentId,
    requiresApproval: false,
    readOnly: null,
    destructive: null,
  }
}

function indexSources(rawSources: readonly AgentToolPlanSource[]): Map<string, AgentToolPlanSource> {
  const sources = new Map<string, AgentToolPlanSource>()
  for (const rawSource of rawSources) {
    const source = normalizeSource(rawSource)
    if (sources.has(source.name)) {
      throw new Error(`Agent 工具计划来源 '${source.name}' 重复`)
    }
    sources.set(source.name, source)
  }
  return sources
}

function normalizeSource(source: AgentToolPlanSource): AgentToolPlanSource {
  const name = source.name.trim()
  if (!name) throw new Error('Agent 工具计划来源缺少名称')
  return { ...source, name }
}

function entryForDefinition(
  name: string,
  definition: unknown,
  schema: unknown,
  sources: ReadonlyMap<string, AgentToolPlanSource>,
): AgentToolPlanEntry {
  const source = sources.get(name)
  if (!source) {
    throw new Error(`模型请求公开了未绑定执行来源的工具 '${name}'`)
  }
  return {
    name,
    kind: source.kind,
    providerId: source.providerId,
    schemaDigest: agentContextDigest(schema),
    definitionDigest: agentContextDigest(definition),
    requiresApproval: source.requiresApproval,
    readOnly: source.readOnly,
    destructive: source.destructive,
  }
}

function schemaForTool(tool: ModelRequest['tools'][number]): unknown {
  return tool.type === 'function' ? tool.parameters : {}
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
