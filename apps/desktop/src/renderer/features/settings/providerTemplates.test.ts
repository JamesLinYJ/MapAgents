// +-------------------------------------------------------------------------
//
//   地理智能平台 - Provider 配置模板测试
//
//   文件:       providerTemplates.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { customProviderConfigSchema } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import {
  createModelSnapshot,
  createProviderTemplateValues,
} from './providerTemplates'

describe('provider setup templates', () => {
  it('uses the approved DeepSeek, OpenAI and Ollama connection defaults', () => {
    expect(createProviderTemplateValues('deepseek').config).toMatchObject({
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'responses',
      networkAccess: 'public',
      defaultModel: 'deepseek-v4-flash',
    })
    expect(createProviderTemplateValues('openai').config).toMatchObject({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'responses',
      networkAccess: 'public',
      models: [],
      defaultModel: '',
    })
    expect(createProviderTemplateValues('ollama').config).toMatchObject({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      protocol: 'chat_completions',
      networkAccess: 'loopback',
      models: [],
      defaultModel: '',
    })
  })

  it('gives unknown models conservative editable capability defaults', () => {
    expect(createModelSnapshot('vendor-model', 'custom')).toEqual({
      modelId: 'vendor-model',
      contextWindowTokens: 128_000,
      capabilities: {
        reasoning: false,
        structuredOutput: true,
        toolCalls: true,
      },
      modalities: ['text'],
    })
  })

  it('marks the preferred DeepSeek v4 model as reasoning capable with a 1M context window', () => {
    expect(createModelSnapshot('deepseek-v4-flash', 'deepseek')).toMatchObject({
      contextWindowTokens: 1_000_000,
      capabilities: { reasoning: true },
    })
  })

  it('returns field-specific Chinese validation errors', () => {
    const result = customProviderConfigSchema.safeParse({
      ...createProviderTemplateValues('custom').config,
      providerId: '',
      displayName: '',
      baseUrl: '',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      '请输入服务标识',
      '请输入显示名称',
      '请输入接口地址',
      '请至少添加一个模型',
      '请选择默认模型',
    ]))
  })
})
