// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 投影工具测试
//
//   文件:       runtimeSdkProjection.test.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { modelSettings } from './runtimeSdkProjection.js'

describe('runtimeSdkProjection', () => {
  it('keeps autonomous tool choice so plan mode cannot force unrelated calls', () => {
    expect(modelSettings(true)).toMatchObject({
      toolChoice: 'auto',
      reasoning: { effort: 'high' },
    })
    expect(modelSettings(false)).toMatchObject({
      toolChoice: 'auto',
    })
    expect(modelSettings(false)).not.toHaveProperty('reasoning')
  })
})
