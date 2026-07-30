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
  defaultModel: 'deepseek-v4-flash',
  availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  capabilities: ['agents_sdk', 'chat_completions', 'tool_calls'],
  contextWindowTokens: 128000,
  agentRuntime: {
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
}

describe('providerCapabilities', () => {
  it('describes the real DeepSeek Agent runtime boundary', () => {
    expect(supportsAgentSdkLiveSupervisor(deepSeekProvider)).toBe(true)
    expect(agentRuntimeCapabilitySummary(deepSeekProvider)).toBe(
      'DeepSeek Chat Completions · 支持同轮多工具响应 · 由 GeoForge 本地安全闸门控制并发 · Hosted Tools、远程 Conversation、服务端压缩不可用',
    )
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
