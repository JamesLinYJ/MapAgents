// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 模型选择辅助
//
//   文件:       modelSelectors.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 线程压缩、记忆搜索和自动整理都需要小模型/结构化模型能力。这里集中模型解析
// 与 JSON 输出边界，避免各命令自行拼接 provider/model fallback 规则。

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionPurpose, type ModelCompletionService } from '../model/modelResultCache.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { isRecord } from './payload.js'

export function makeSummarizer(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
  cached?: CachedCompletionContext,
) {
  return async (prompt: string): Promise<string> => {
    const adapter = registry.resolveProvider(requestedProvider ?? config.context.summaryProvider)
    if (cached) {
      const response = await cached.service.completeText({
        workspaceId: cached.workspaceId,
        ...(cached.runId ? { runId: cached.runId } : {}),
        provider: adapter.provider,
        model: requestedModel ?? config.context.summaryModel ?? adapter.subagentModel ?? adapter.defaultModel,
        purpose: 'thread_summary',
        prompt,
      })
      if (cached.store && cached.runId) await recordModelCompletionUsage(cached.store, cached.runId, response)
      return response.content
    }
    const response = await adapter.chat(prompt, {
      model: requestedModel ?? config.context.summaryModel ?? adapter.subagentModel ?? adapter.defaultModel,
      reasoning: false,
    })
    if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('摘要模型未返回文本')
    return response.content.trim()
  }
}

export function makeOptionalStructuredSelector(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
  cached?: CachedCompletionContext,
): ((prompt: string) => Promise<Record<string, unknown>>) | undefined {
  if (!requestedProvider && !requestedModel && !config.context.summaryProvider && !registry.defaultProvider) return undefined
  return makeStructuredSelector(registry, config, requestedProvider, requestedModel, cached)
}

export function makeStructuredSelector(
  registry: ModelAdapterRegistry,
  config: AgentRuntimeConfig,
  requestedProvider: string | null,
  requestedModel: string | null,
  cached?: CachedCompletionContext,
) {
  return async (prompt: string): Promise<Record<string, unknown>> => {
    const provider = requestedProvider ?? config.context.summaryProvider ?? registry.defaultProvider
    if (!provider) throw new Error('未配置记忆选择模型 provider')
    const adapter = registry.resolveProvider(provider)
    const model = requestedModel ?? config.context.summaryModel ?? adapter.subagentModel ?? adapter.defaultModel
    if (!model) throw new Error('未配置记忆选择模型')
    if (cached) {
      const response = await cached.service.completeJson({
        workspaceId: cached.workspaceId,
        ...(cached.runId ? { runId: cached.runId } : {}),
        provider: adapter.provider,
        model,
        purpose: cached.purpose ?? 'memory_selection',
        prompt,
      })
      if (cached.store && cached.runId) await recordModelCompletionUsage(cached.store, cached.runId, response)
      return response.content
    }
    const response = await adapter.chat(prompt, {
      model,
      reasoning: false,
    })
    if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('结构化模型未返回文本')
    return parseStructuredJson(response.content)
  }
}

interface CachedCompletionContext {
  service: ModelCompletionService
  workspaceId: string
  store?: PlatformPersistenceFacade
  runId?: string | null
  purpose?: ModelCompletionPurpose
}

function parseStructuredJson(value: string): Record<string, unknown> {
  const cleaned = value.trim().replace(/^```json\s*|\s*```$/gu, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!isRecord(parsed)) throw new Error('结构化模型输出必须是 JSON object')
  return parsed
}
