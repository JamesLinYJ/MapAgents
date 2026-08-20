// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 检查点兼容性测试
//
//   文件:       agentsCheckpointService.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'
import { assertCheckpointCompatibility } from './agentsCheckpointService.js'

const validCheckpoint = {
  orchestrationEngine: 'openai_agents',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentsSdkVersion: '0.16.1',
  runtimeConfigDigest: 'sha256:config',
}

describe('Agents checkpoint compatibility', () => {
  it('接受完全匹配的 SDK 检查点', () => {
    expect(() => assertCheckpointCompatibility(validCheckpoint, {
      runId: 'run_1',
      sdkVersion: '0.16.1',
      configDigest: 'sha256:config',
    })).not.toThrow()
  })

  it.each([
    [{ ...validCheckpoint, orchestrationEngine: null }, '不是 OpenAI Agents SDK 检查点'],
    [{ ...validCheckpoint, sdkStateSchemaVersion: null }, 'SDK 状态 schema 不匹配'],
    [{ ...validCheckpoint, agentsSdkVersion: '0.15.0' }, 'SDK 版本不匹配'],
    [{ ...validCheckpoint, runtimeConfigDigest: 'sha256:other' }, '运行配置已变化'],
  ])('拒绝不兼容检查点', (checkpoint, message) => {
    expect(() => assertCheckpointCompatibility(checkpoint, {
      runId: 'run_1',
      sdkVersion: '0.16.1',
      configDigest: 'sha256:config',
    })).toThrow(message)
  })
})
