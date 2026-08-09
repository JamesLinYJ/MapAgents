// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型与账号配置页测试
//
//   文件:       modelSettingsPage.test.tsx
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ModelSettingsPage } from '../features/settings/ModelSettingsPage'

describe('ModelSettingsPage', () => {
  it('shows only catalog models and keeps account management optional', () => {
    const html = renderToStaticMarkup(
      <ModelSettingsPage
        authMode="local_auto"
        canAccessAccount
        provider="deepseek"
        model="deepseek-v4-flash"
        providers={[deepSeek(), unavailableProvider()]}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    )

    expect(html).toContain('本机身份由应用托管')
    expect(html).toContain('deepseek-v4-flash')
    expect(html).toContain('128,000 词元')
    expect(html).not.toContain('deepseek-v4-pro')
    expect(html).toContain('DeepSeek Responses API')
    expect(html).toContain('打开账号中心')
    expect(html).not.toContain('任意模型名称')
    expect(html).toContain('disabled=""')
  })
})

function deepSeek(): ModelProviderDescriptor {
  return {
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
    contextWindowTokens: 128_000,
    agentRuntime: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
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
}

function unavailableProvider(): ModelProviderDescriptor {
  return {
    ...deepSeek(),
    provider: 'disabled',
    displayName: '未配置服务',
    configured: false,
    defaultModel: null,
    availableModels: [],
    capabilities: [],
    agentRuntime: {
      ...deepSeek().agentRuntime,
      transport: 'none',
      structuredOutput: 'none',
      functionTools: false,
      localMcp: false,
      handoffs: false,
      multiToolResponse: false,
    },
  }
}
