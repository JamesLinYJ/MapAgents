// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 能力判定测试
//
//   文件:       providerCapabilities.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'

import {
  agentRuntimeCapabilitySummary,
  supportsAgentSdkLiveSupervisor,
} from './providerCapabilities'

const deepSeekProvider: ModelProviderDescriptor = {
  provider: 'deepseek',
  displayName: 'DeepSeek',
  configured: true,
  source: 'builtin',
  defaultModel: 'deepseek-v4-flash',
  availableModels: ['deepseek-v4-flash'],
  models: [{
    modelId: 'deepseek-v4-flash',
    contextWindowTokens: 128_000,
    capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
    modalities: ['text'],
  }],
  capabilities: ['agents_sdk_live_supervisor', 'responses', 'tool_calls'],
  modalities: ['text'],
  protocol: 'responses',
  contextWindowTokens: 128000,
  agentRuntime: {
    transport: 'deepseek_responses',
    structuredOutput: 'json_schema',
    functionTools: true,
    localMcp: true,
    hostedTools: true,
    handoffs: true,
    multiToolResponse: true,
    providerParallelToolControl: false,
    remoteConversation: false,
    serverCompaction: false,
  },
}

describe('providerCapabilities', () => {
  it('describes the real DeepSeek Agent runtime boundary', () => {
    expect(supportsAgentSdkLiveSupervisor(deepSeekProvider)).toBe(true)
    expect(agentRuntimeCapabilitySummary(deepSeekProvider)).toBe(
      'DeepSeek Responses API · 支持同轮多工具响应 · 由平台本地安全闸门控制并发 · 支持服务端联网搜索 · 远程 Conversation、服务端压缩不可用',
    )
  })

  it('requires the explicit live-supervisor capability instead of inferring it from transport labels', () => {
    expect(supportsAgentSdkLiveSupervisor({
      ...deepSeekProvider,
      capabilities: ['responses', 'tool_calls'],
    })).toBe(false)
  })

  it('does not imply Agent support when no transport is available', () => {
    expect(agentRuntimeCapabilitySummary({
      ...deepSeekProvider,
      agentRuntime: {
        ...deepSeekProvider.agentRuntime,
        transport: 'none',
      },
    })).toBe('该提供商当前未接入 Agent 运行时。')
  })
})
