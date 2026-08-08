// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runner 模型输入预算控制测试
//
//   文件:       runtimeModelInput.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem } from '@openai/agents'
import { describe, expect, it, vi } from 'vitest'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { RuntimeModelInputController } from './runtimeModelInput.js'

describe('RuntimeModelInputController', () => {
  it('compacts only complete old groups and keeps current input plus unresolved calls intact', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 2_000,
      compactRatio: 0.2,
      hardLimitRatio: 0.9,
      preserveRecentTurns: 1,
      inlineToolResultMaxChars: 100,
    }
    const persisted = vi.fn(async () => undefined)
    const estimatedUpdates: number[] = []
    const controller = new RuntimeModelInputController({
      config,
      summarize: async prompt => {
        expect(prompt).toContain('result_old')
        expect(prompt).toContain('ref_dataset')
        expect(prompt).not.toContain('x'.repeat(200))
        return '旧轮次已完成数据检查，结果引用为 ref_dataset。'
      },
      resolveToolOutput: async callId => callId === 'call_old'
        ? {
            callId,
            toolName: 'inspect_dataset',
            resultId: 'result_old',
            summary: '数据检查完成',
            valueRefIds: ['ref_dataset'],
            artifactIds: [],
          }
        : null,
      persistSummary: persisted,
      updateEstimatedTokens: async tokens => { estimatedUpdates.push(tokens) },
    })
    const oldPair: AgentInputItem[] = [
      { type: 'message', role: 'user', content: `旧问题：${'旧'.repeat(1_000)}` },
      { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '先检查旧数据' }] },
      {
        type: 'function_call',
        status: 'completed',
        callId: 'call_old',
        name: 'inspect_dataset',
        arguments: '{}',
      },
      {
        type: 'function_call_result',
        status: 'completed',
        callId: 'call_old',
        name: 'inspect_dataset',
        output: { type: 'text', text: 'x'.repeat(1_000) },
      },
      { type: 'message', role: 'assistant', status: 'completed', content: '旧轮次完成。' },
    ]
    const unresolved: AgentInputItem = {
      type: 'function_call',
      status: 'completed',
      callId: 'call_current',
      name: 'query_layer',
      arguments: '{}',
    }
    const result = await controller.filter({
      input: [
        { type: 'message', role: 'system', content: '系统约束' },
        ...oldPair,
        unresolved,
      ],
    }, [
      { type: 'message', role: 'user', content: '当前问题' },
    ])

    expect(result.input).toContainEqual(expect.objectContaining({
      type: 'message',
      role: 'system',
      content: expect.stringContaining('<run-history-summary'),
    }))
    expect(result.input).toContainEqual(unresolved)
    expect(result.input).toContainEqual({ type: 'message', role: 'user', content: '当前问题' })
    expect(result.input.some(item => item.type === 'function_call_result' && item.callId === 'call_old')).toBe(false)
    expect(result.input.some(item => item.type === 'function_call' && item.callId === 'call_old')).toBe(false)
    expect(persisted).toHaveBeenCalledOnce()
    expect(estimatedUpdates).toEqual([
      expect.any(Number),
    ])
    expect(estimatedUpdates[0]).toBe(persisted.mock.calls[0]?.[0].estimatedTokensAfter)
  })

  it('fails explicitly when the current input alone exceeds the hard limit', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 100,
      compactRatio: 0.5,
      hardLimitRatio: 0.6,
      preserveRecentTurns: 6,
    }
    const controller = new RuntimeModelInputController({
      config,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })

    await expect(controller.filter({
      input: [{ type: 'message', role: 'system', content: '系统约束' }],
    }, [
      { type: 'message', role: 'user', content: '当前'.repeat(1_000) },
    ])).rejects.toThrow('没有可安全压缩的完整旧消息组')
  })

  it('does not persist identical context telemetry on every model callback', async () => {
    const updates: number[] = []
    const controller = new RuntimeModelInputController({
      config: defaultRuntimeConfig().context,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      updateEstimatedTokens: async tokens => { updates.push(tokens) },
    })
    const modelData = {
      input: [{ type: 'message', role: 'user', content: '查询杭州天气' }] satisfies AgentInputItem[],
    }

    await controller.filter(modelData, [])
    await controller.filter(modelData, [])

    expect(updates).toHaveLength(1)
  })
})
