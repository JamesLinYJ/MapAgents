// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行元数据测试
//
//   文件:       agentsRuntimeMetadata.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  agentsSdkVersion,
  assertAgentsSdkVersionSupported,
  SUPPORTED_AGENTS_SDK_VERSION,
} from './agentsRuntimeMetadata.js'

describe('Agents SDK runtime metadata', () => {
  it('锁定经过契约验证的 SDK 版本', async () => {
    const installed = await agentsSdkVersion()
    expect(installed).toBe(SUPPORTED_AGENTS_SDK_VERSION)
    expect(() => assertAgentsSdkVersionSupported(installed)).not.toThrow()
    expect(() => assertAgentsSdkVersionSupported('0.15.0')).toThrow('不支持的')
  })
})
