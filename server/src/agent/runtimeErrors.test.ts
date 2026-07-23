// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 稳定错误映射测试
//
//   文件:       runtimeErrors.test.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  UserError,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { runtimeFailureMessage } from './runtimeErrors.js'

describe('runtimeFailureMessage', () => {
  it('does not expose English SDK internals or mislabel every UserError as a DeepSeek error', () => {
    expect(runtimeFailureMessage(new UserError('serialized state is incompatible'))).toBe(
      'Agents SDK 拒绝了当前运行配置或恢复状态；请查看服务端日志。',
    )
  })

  it('preserves stable Chinese boundary errors', () => {
    expect(runtimeFailureMessage(new UserError('当前 Sandbox backend 与检查点不一致。'))).toBe(
      '当前 Sandbox backend 与检查点不一致。',
    )
  })

  it('maps SDK control errors to stable Chinese messages', () => {
    expect(runtimeFailureMessage(new MaxTurnsExceededError('limit'))).toContain('最大运行轮次')
    expect(runtimeFailureMessage(new ModelBehaviorError('bad output'))).toContain('不符合 Agent 协议')
  })
})
