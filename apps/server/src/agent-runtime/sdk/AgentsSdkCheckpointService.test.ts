// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK checkpoint 防腐层契约测试
//
//   文件:       AgentsSdkCheckpointService.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import {
  Agent,
  RunContext,
  Runner,
  type AgentInputItem,
  type Model,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'

import { SDK_STATE_SCHEMA_VERSION } from '../../agent/agentsRuntimeMetadata.js'
import { AgentsSdkBridge } from './AgentsSdkBridge.js'
import {
  AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
  AgentsSdkCheckpointCodec,
} from './AgentsSdkCheckpointCodec.js'
import { assertCheckpointCompatibility } from './AgentsSdkCheckpointService.js'

const validCheckpoint = {
  orchestrationEngine: 'openai_agents',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentsSdkVersion: '0.17.0',
  runtimeConfigDigest: 'sha256:config',
}

describe('Agents SDK checkpoint anti-corruption boundary', () => {
  it('只解析平台 envelope，并把 SDK 序列化状态保持为 opaque 字符串', () => {
    const codec = new AgentsSdkCheckpointCodec()
    const envelope = {
      envelopeVersion: AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
      publicSerializedState: '{"sdk":"opaque"}',
      sdkVersion: '0.17.0',
      sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
      runtimeConfigDigest: 'sha256:config',
      toolPlanDigest: 'sha256:tools',
      worldRevision: 7,
      inputCursor: 3,
      segmentId: 'segment_1',
      stepId: 'step_1',
    } as const

    expect(codec.decode(codec.encode(envelope))).toEqual(envelope)
    expect(() => codec.decode(JSON.stringify({
      ...envelope,
      sdkInternalField: [],
    }))).toThrow()
  })

  it('仅通过 RunState 公开 API 暂存输入并完成 round-trip', async () => {
    const bridge = new AgentsSdkBridge()
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        throw new Error('checkpoint bridge test 不应调用非流式模型')
      },
      async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
        throw new Error('segment rotation 应在 provider 发包前发生')
      },
    }
    const agent = new Agent<{ runId: string }>({
      name: 'checkpoint-contract-agent',
      instructions: 'checkpoint contract test',
      model,
    })
    const context = { runId: 'run_1' }
    const rotation = new Error('controlled segment rotation')
    const stream = await new Runner().run(
      agent,
      'initial input',
      {
        stream: true,
        context: new RunContext(context),
        callModelInputFilter: async () => {
          throw rotation
        },
      },
    )
    await expect((async () => {
      for await (const _event of stream) {
        // 轮换信号在 provider 发包前触发，因此不会产生事件。
      }
      await stream.completed
    })()).rejects.toBe(rotation)
    const input = runInput('run_1', 1, '继续分析')

    bridge.stageInput(stream.state, [input])
    const restored = await bridge.restore({
      agent,
      context,
      publicSerializedState: bridge.serialize(stream.state),
    })

    expect(restored.pendingInput).toEqual([input])
  })

  it('接受完全匹配的 SDK 检查点', () => {
    expect(() => assertCheckpointCompatibility(validCheckpoint, {
      runId: 'run_1',
      sdkVersion: '0.17.0',
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
      sdkVersion: '0.17.0',
      configDigest: 'sha256:config',
    })).toThrow(message)
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
