// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 状态防腐边界测试
//
//   文件:       agentsSdkStateBoundary.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { AgentInputItem } from '@openai/agents'
import { describe, expect, it } from 'vitest'

import {
  stageRunInputsInSdkState,
  toolCallResultIdsFromHistory,
  type AgentsSdkSerializableInputState,
} from './agentsSdkStateBoundary.js'

describe('Agents SDK state boundary', () => {
  it('幂等接纳带持久 sequence 的 steering 输入', () => {
    const state: AgentsSdkSerializableInputState = { _originalInput: 'initial' }
    const item = runInput('run_1', 1, '继续分析')

    stageRunInputsInSdkState(state, 'run_1', [item])
    stageRunInputsInSdkState(state, 'run_1', [structuredClone(item)])

    expect(state._originalInput).toEqual([
      { type: 'message', role: 'user', content: 'initial' },
      item,
    ])
  })

  it('拒绝跨 Run、缺 marker 和同 sequence 不同内容', () => {
    const state: AgentsSdkSerializableInputState = { _originalInput: [] }
    expect(() => stageRunInputsInSdkState(
      state,
      'run_1',
      [runInput('run_2', 1, 'cross-run')],
    )).toThrow('缺少可序列化 marker')

    expect(() => stageRunInputsInSdkState(state, 'run_1', [{
      type: 'message',
      role: 'user',
      content: 'missing marker',
    }])).toThrow('缺少可序列化 marker')

    stageRunInputsInSdkState(state, 'run_1', [runInput('run_1', 1, 'first')])
    expect(() => stageRunInputsInSdkState(
      state,
      'run_1',
      [runInput('run_1', 1, 'changed')],
    )).toThrow('内容不一致')
  })

  it('只从公开 history 中提取 function call 结果', () => {
    const history: AgentInputItem[] = [
      {
        type: 'function_call',
        name: 'lookup',
        callId: 'call_pending',
        status: 'completed',
        arguments: '{}',
      },
      {
        type: 'function_call_result',
        name: 'lookup',
        callId: 'call_done',
        status: 'completed',
        output: { type: 'text', text: 'ok' },
      },
      {
        type: 'function_call_result',
        name: 'lookup',
        callId: 'call_done',
        status: 'completed',
        output: { type: 'text', text: 'same' },
      },
    ]

    expect(toolCallResultIdsFromHistory(history)).toEqual(['call_done'])
  })
})

function runInput(runId: string, inputSequence: number, content: string): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content,
    providerData: {
      geoAgentRunInput: {
        runId,
        inputId: `input_${inputSequence}`,
        inputSequence,
      },
    },
  }
}
