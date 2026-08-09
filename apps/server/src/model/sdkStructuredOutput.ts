// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 原生结构化输出执行器
//
//   文件:       sdkStructuredOutput.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Agent, Runner, type ModelResponse } from '@openai/agents'
import { z } from 'zod'
import { resolveAdapterModelCapabilities, type ModelAdapter } from './registry.js'
import type { NormalizedModelUsage } from './modelResultCache.js'

export type StructuredOutputSchema = z.ZodObject

export interface StructuredModelOutput<TSchema extends StructuredOutputSchema> {
  content: z.infer<TSchema>
  usage: NormalizedModelUsage
}

/**
 * 只在 provider 明确提供 Responses/Agents SDK 原生 JSON Schema 能力时执行。
 * 不把 SDK 协议错误降级成自由文本解析，避免模型输出与 schema 事实源分叉。
 */
export async function runSdkStructuredOutput<TSchema extends StructuredOutputSchema>(
  adapter: ModelAdapter,
  modelName: string,
  prompt: string,
  schema: TSchema,
  signal?: AbortSignal,
): Promise<StructuredModelOutput<TSchema>> {
  const modelCapabilities = resolveAdapterModelCapabilities(adapter, modelName)
  if (
    adapter.agentRuntimeCapabilities.structuredOutput !== 'json_schema'
    || !modelCapabilities.capabilities.structuredOutput
    || !adapter.createAgentModel
  ) {
    throw new Error(`模型 '${modelCapabilities.modelId}' 不支持 SDK 原生 JSON Schema 结构化输出`)
  }
  const model = adapter.createAgentModel(modelName)
  const agent = new Agent<undefined, TSchema>({
    name: '平台结构化输出',
    instructions: '严格依据用户输入生成符合输出 schema 的对象；不得添加 schema 以外的字段。',
    model,
    modelSettings: { temperature: 0 },
    outputType: schema,
    tools: [],
  })
  const result = await new Runner({
    model,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  }).run(agent, prompt, {
    maxTurns: 1,
    ...(signal ? { signal } : {}),
  })
  if (result.finalOutput === undefined) throw new Error('SDK 结构化模型未返回最终输出')
  return {
    content: schema.parse(result.finalOutput),
    usage: aggregateSdkUsage(result.rawResponses),
  }
}

function aggregateSdkUsage(responses: ModelResponse[]): NormalizedModelUsage {
  return responses.reduce<NormalizedModelUsage>((total, response) => ({
    inputTokens: total.inputTokens + response.usage.inputTokens,
    outputTokens: total.outputTokens + response.usage.outputTokens,
    totalTokens: total.totalTokens + response.usage.totalTokens,
    cacheHitInputTokens: total.cacheHitInputTokens + usageDetail(response.usage.inputTokensDetails, [
      'cached_tokens',
      'cache_read_input_tokens',
      'prompt_cache_hit_tokens',
    ]),
    cacheMissInputTokens: total.cacheMissInputTokens + usageDetail(response.usage.inputTokensDetails, [
      'cache_creation_input_tokens',
      'prompt_cache_miss_tokens',
    ]),
    cacheDetailReported: total.cacheDetailReported + (response.usage.inputTokensDetails.length > 0 ? 1 : 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheDetailReported: 0,
  })
}

function usageDetail(details: Array<Record<string, number>>, keys: string[]): number {
  return details.reduce((total, detail) => total + keys.reduce((subtotal, key) => {
    const value = detail[key]
    return subtotal + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  }, 0), 0)
}
