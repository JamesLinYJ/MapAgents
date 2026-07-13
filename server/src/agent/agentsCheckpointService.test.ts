// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 检查点兼容性测试
//
//   文件:       agentsCheckpointService.test.ts
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'
import { assertCheckpointCompatibility } from './agentsCheckpointService.js'

const validCheckpoint = {
  orchestrationEngine: 'openai_agents',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentsSdkVersion: '0.11.8',
  runtimeConfigDigest: 'sha256:config',
}

describe('Agents checkpoint compatibility', () => {
  it('接受完全匹配的 SDK 检查点', () => {
    expect(() => assertCheckpointCompatibility(validCheckpoint, {
      runId: 'run_1',
      sdkVersion: '0.11.8',
      configDigest: 'sha256:config',
    })).not.toThrow()
  })

  it.each([
    [{ ...validCheckpoint, orchestrationEngine: null }, '不是 OpenAI Agents SDK 检查点'],
    [{ ...validCheckpoint, sdkStateSchemaVersion: null }, 'SDK 状态 schema 不匹配'],
    [{ ...validCheckpoint, agentsSdkVersion: '0.11.7' }, 'SDK 版本不匹配'],
    [{ ...validCheckpoint, runtimeConfigDigest: 'sha256:other' }, '运行配置已变化'],
  ])('拒绝不兼容检查点', (checkpoint, message) => {
    expect(() => assertCheckpointCompatibility(checkpoint, {
      runId: 'run_1',
      sdkVersion: '0.11.8',
      configDigest: 'sha256:config',
    })).toThrow(message)
  })
})
