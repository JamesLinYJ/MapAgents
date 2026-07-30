// +-------------------------------------------------------------------------
//
//   地理智能平台 - DeepSeek Provider 模型边界测试
//
//   文件:       deepseek.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { createDeepSeekAdapter } from './deepseek.js'

describe('DeepSeek configured model boundary', () => {
  it('rejects a host CLI model before issuing a provider request', () => {
    const adapter = createAdapter()

    expect(() => adapter.createAgentModel?.('gpt-5.6-sol'))
      .toThrow("DeepSeek 模型 'gpt-5.6-sol' 不在本服务允许列表中")
  })

  it('accepts only the configured primary and subagent models', () => {
    const adapter = createAdapter()

    expect(adapter.availableModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(() => adapter.createAgentModel?.('deepseek-v4-flash')).not.toThrow()
    expect(() => adapter.createAgentModel?.('deepseek-v4-pro')).not.toThrow()
    expect(() => adapter.createAgentModel?.('deepseek-chat')).toThrow('不在本服务允许列表中')
  })

  it('does not report an invalid cross-provider default as configured', () => {
    const adapter = createDeepSeekAdapter({
      baseUrl: 'https://api.deepseek.example/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-5.6-sol',
      toolSchemaMode: 'compatible',
    })

    expect(adapter.isConfigured()).toBe(false)
  })
})

function createAdapter() {
  return createDeepSeekAdapter({
    baseUrl: 'https://api.deepseek.example/v1',
    apiKey: 'test-key',
    defaultModel: 'deepseek-v4-flash',
    subagentModel: 'deepseek-v4-pro',
    toolSchemaMode: 'compatible',
  })
}
