// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型适配器注册表
//
//   文件:       registry.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { AgentRuntimeCapabilities, ModelProviderDescriptor } from '../schemas/types.js'
import type { Env } from '../framework/env.js'
import type { Model } from '@openai/agents'
import { createDeepSeekAdapter } from './providers/deepseek.js'
import { createAnthropicAdapter } from './providers/anthropic.js'
import { createGeminiAdapter } from './providers/gemini.js'
import { createOllamaAdapter } from './providers/ollama.js'

export type AgentToolSchemaMode = 'strict' | 'compatible'

/** 模型适配器的静态扩展点；运行时注册表必须为每个 ID 提供实现。 */
export const MODEL_PROVIDER_IDS = ['deepseek', 'anthropic', 'gemini', 'ollama'] as const
export type ModelProviderId = typeof MODEL_PROVIDER_IDS[number]

export interface ModelAdapter {
  readonly provider: string
  readonly displayName: string
  readonly defaultModel: string | null
  readonly subagentModel?: string
  readonly availableModels?: readonly string[]
  readonly contextWindowTokens?: number
  readonly agentToolSchemaMode: AgentToolSchemaMode
  readonly agentRuntimeCapabilities: AgentRuntimeCapabilities
  readonly cacheNamespace?: string

  isConfigured(): boolean
  capabilities(): string[]
  warmup?(): Promise<void>
  createAgentModel?(modelName?: string | null): Model
  chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>>
  close?(): Promise<void>
}

// --- Registry ---

export class ModelAdapterRegistry {
  private adapters = new Map<string, ModelAdapter>()
  readonly defaultProvider: string
  readonly defaultModelName: string | null

  constructor(env: Env) {
    this.defaultProvider = env.DEFAULT_MODEL_PROVIDER ?? ''
    this.defaultModelName = env.DEFAULT_MODEL_NAME ?? null

    const dmf = (p: string) => env.DEFAULT_MODEL_PROVIDER === p ? (env.DEFAULT_MODEL_NAME ?? '') : ''

    this.register(createDeepSeekAdapter({
      baseUrl: env.DEEPSEEK_BASE_URL ?? '',
      apiKey: env.DEEPSEEK_API_KEY ?? '',
      defaultModel: (env.DEEPSEEK_MODEL ?? dmf('deepseek')),
      toolSchemaMode: env.DEEPSEEK_TOOL_SCHEMA_MODE,
    }))
    this.register(createAnthropicAdapter({
      baseUrl: env.ANTHROPIC_BASE_URL ?? '',
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      defaultModel: (env.ANTHROPIC_MODEL ?? dmf('anthropic')),
      version: env.ANTHROPIC_VERSION ?? '',
    }))
    this.register(createGeminiAdapter({
      baseUrl: env.GEMINI_BASE_URL ?? '',
      apiKey: env.GEMINI_API_KEY ?? '',
      defaultModel: (env.GEMINI_MODEL ?? dmf('gemini')),
    }))
    this.register(createOllamaAdapter({
      baseUrl: env.OLLAMA_BASE_URL ?? '',
      defaultModel: (env.OLLAMA_MODEL ?? dmf('ollama')),
    }))
  }

  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.provider, adapter)
  }

  get(provider: string): ModelAdapter {
    const a = this.adapters.get(provider)
    if (!a) throw new Error(`未注册的 provider: ${provider}`)
    return a
  }

  resolveProvider(provider?: string | null): ModelAdapter {
    const selected = provider ?? this.defaultProvider
    if (!selected) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
    const adapter = this.adapters.get(selected)
    if (!adapter) throw new Error(`未注册的模型 provider: ${selected}`)
    if (!adapter.isConfigured()) throw new Error(`模型 provider '${selected}' 尚未配置`)
    return adapter
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort()
  }

  descriptors(): ModelProviderDescriptor[] {
    return [...this.adapters.values()].map(a => {
      const labels = a.createAgentModel
        ? [
            'agents_sdk_live_supervisor',
            `agents_sdk_transport_${a.agentRuntimeCapabilities.transport}`,
            `tool_schema_${a.agentToolSchemaMode}`,
          ]
        : []

      return {
        provider: a.provider,
        displayName: a.displayName,
        configured: a.isConfigured(),
        defaultModel: a.defaultModel,
        availableModels: [...new Set([
          ...(a.availableModels ?? []),
          ...(a.defaultModel ? [a.defaultModel] : []),
          ...(a.subagentModel ? [a.subagentModel] : []),
        ])],
        capabilities: [...a.capabilities(), ...labels],
        agentRuntime: a.agentRuntimeCapabilities,
        contextWindowTokens: a.contextWindowTokens ?? inferContextWindow(a.defaultModel),
      }
    })
  }

  /**
   * Provider transport 预热属于启动就绪的一部分。只预热已配置的默认
   * provider；未配置 provider 不触发外部网络，也不改变可选 provider 的
   * 发现和错误语义。
   */
  async warmup(): Promise<void> {
    const provider = this.defaultProvider.trim()
    if (!provider) return
    const adapter = this.adapters.get(provider)
    if (!adapter?.isConfigured()) return
    await adapter.warmup?.()
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(adapter => adapter.close?.()))
  }
}

function inferContextWindow(model: string | null): number {
  const normalized = (model ?? '').toLowerCase()
  if (normalized.includes('gemini-2.5')) return 1_000_000
  return 128_000
}
