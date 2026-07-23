// +-------------------------------------------------------------------------
//
//   地理智能平台 - DeepSeek OpenAI-compatible 适配器
//
//   文件:       deepseek.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions'
import type { AgentToolSchemaMode, ModelAdapter } from '../registry.js'
import { abortSignalWithTimeout } from '../../utils/abort.js'
import {
  DeepSeekChatCompletionsModel,
} from '../deepSeekChatCompletionsModel.js'

export interface DeepSeekOptions {
  baseUrl: string
  apiKey: string
  defaultModel: string
  subagentModel?: string
  displayName?: string
  toolSchemaMode: AgentToolSchemaMode
}
export function createDeepSeekAdapter(opts: DeepSeekOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const client = opts.apiKey ? new OpenAI({ baseURL: baseUrl, apiKey: opts.apiKey }) : null

  return {
    provider: 'deepseek',
    displayName: opts.displayName ?? 'DeepSeek',
    defaultModel: opts.defaultModel,
    ...(opts.subagentModel ? { subagentModel: opts.subagentModel } : {}),
    contextWindowTokens: inferContextWindow(opts.defaultModel),
    agentToolSchemaMode: opts.toolSchemaMode,
    agentRuntimeCapabilities: {
      transport: 'deepseek_chat_completions',
      structuredOutput: 'json_object',
      functionTools: true,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    cacheNamespace: baseUrl,

    isConfigured(): boolean {
      return Boolean(baseUrl && opts.apiKey && opts.defaultModel)
    },

    createAgentModel(modelName?: string | null) {
      if (!client) throw new Error('DeepSeek provider 未配置 API key')
      const model = modelName ?? opts.defaultModel
      if (!model) throw new Error('DeepSeek provider 未配置模型名称')
      return new DeepSeekChatCompletionsModel({ client, model })
    },

    capabilities: () => ['chat', 'structured', 'stream', 'chat_completions'],

    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!client) throw new Error('DeepSeek provider 未配置 API key')
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]

      const request: ChatCompletionCreateParamsNonStreaming & {
        thinking: { type: 'enabled' | 'disabled' }
      } = {
        model,
        messages: messages.map(m => toBasicMessage(m.role, m.content)),
        stream: false,
        ...(typeof kwargs?.temperature === 'number' ? { temperature: kwargs.temperature } : {}),
        ...(kwargs?.reasoning !== false ? { reasoning_effort: 'high' as const } : {}),
        thinking: { type: kwargs?.reasoning === false ? 'disabled' : 'enabled' },
      }
      const completion = await client.chat.completions.create(request, {
        signal: abortSignalWithTimeout(kwargs?.signal, 60_000),
      })

      const content = completion.choices[0]?.message?.content ?? ''
      return { provider: 'deepseek', content, raw: completion as unknown as Record<string, unknown>, model }
    },

  }
}

function inferContextWindow(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes('gpt-4.1')) return 1_000_000
  if (normalized.includes('gpt-4o')) return 128_000
  if (normalized.includes('deepseek-v4')) return 1_000_000
  if (normalized.includes('deepseek')) return 128_000
  return 128_000
}

function toBasicMessage(role: string, content: string): ChatCompletionMessageParam {
  if (role === 'assistant') return { role: 'assistant', content }
  if (role === 'system') return { role: 'system', content }
  return { role: 'user', content }
}
