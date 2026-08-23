// +-------------------------------------------------------------------------
//
//   地理智能平台 - 精确 ModelRequest 日志
//
//   文件:       ModelRequestJournal.ts
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   provider 发包前把去除 AbortSignal 的完整请求写入内容寻址对象，并与
//   StepContext / input.included 原子绑定。恢复只重放该对象，不重新拼接请求。
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import {
  MODEL_REQUEST_RECORD_SCHEMA_VERSION,
  type ModelRequestRecord,
} from '@geo-agent-platform/shared-types/model-request'

import { isRecord, stableJson } from '../../framework/schema.js'
import { runInputConversationItem } from '../../store/runInputConversationItem.js'
import type { AgentRuntimeStore } from '../../store/runtimePorts.js'
import { makeId, nowUtc } from '../../utils/ids.js'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

type PersistedModelRequest = Omit<ModelRequest, 'signal'>

export class ModelRequestJournal {
  constructor(private readonly store: AgentRuntimeStore) {}

  async commit(input: {
    runId: string
    provider: string
    modelId: string
    context: RecordedAgentStepContext
    request: ModelRequest
  }): Promise<{ record: ModelRequestRecord; request: ModelRequest }> {
    const snapshot = snapshotRequest(input.request)
    const serialized = stableJson(snapshot)
    const committed = await this.store.publishModelRequestSnapshot(serialized, {
      schemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
      requestId: makeId('model_request'),
      runId: input.runId,
      turnId: input.context.turnId,
      stepId: input.context.identity.stepId,
      segmentId: input.context.identity.segmentId,
      provider: input.provider,
      modelId: input.modelId,
      inputDigest: agentContextDigest(snapshot.input),
      instructionsDigest: agentContextDigest(snapshot.systemInstructions ?? null),
      toolPlanDigest: input.context.toolPlanDigest,
      worldRevision: input.context.worldRevision,
      summaryObjectHashes: [],
      createdAt: nowUtc(),
    })
    await this.store.projectPersistedItems(
      committed.includedInputs.map(runInputConversationItem),
    )
    return {
      record: committed.record,
      request: withCurrentSignal(snapshot, input.request.signal),
    }
  }

  async replay(
    record: ModelRequestRecord,
    currentRequest: ModelRequest,
  ): Promise<ModelRequest> {
    const serialized = await this.store.readModelRequestSnapshot(record)
    const parsed = parseSnapshot(serialized, record.requestId)
    if (stableJson(parsed) !== serialized) {
      throw new Error(`模型请求 '${record.requestId}' 对象不是 canonical JSON`)
    }
    if (agentContextDigest(parsed.input) !== record.inputDigest) {
      throw new Error(`模型请求 '${record.requestId}' input digest 校验失败`)
    }
    if (agentContextDigest(parsed.systemInstructions ?? null) !== record.instructionsDigest) {
      throw new Error(`模型请求 '${record.requestId}' instructions digest 校验失败`)
    }
    return withCurrentSignal(parsed, currentRequest.signal)
  }
}

function snapshotRequest(request: ModelRequest): PersistedModelRequest {
  const { signal: _signal, ...persistable } = request
  const encoded = JSON.stringify(persistable)
  if (!encoded) throw new Error('ModelRequest 不能序列化为 JSON')
  return parseSnapshot(encoded, 'new')
}

function parseSnapshot(serialized: string, requestId: string): PersistedModelRequest {
  const value: unknown = JSON.parse(serialized)
  if (
    !isRecord(value)
    || !(typeof value.input === 'string' || Array.isArray(value.input))
    || !isRecord(value.modelSettings)
    || !Array.isArray(value.tools)
    || !Array.isArray(value.handoffs)
    || !(
      typeof value.tracing === 'boolean'
      || value.tracing === 'enabled_without_data'
    )
    || !(typeof value.outputType === 'string' || isRecord(value.outputType))
  ) {
    throw new Error(`模型请求 '${requestId}' 对象结构不完整`)
  }
  return value as PersistedModelRequest
}

function withCurrentSignal(
  snapshot: PersistedModelRequest,
  signal: AbortSignal | undefined,
): ModelRequest {
  const copy = structuredClone(snapshot)
  return signal ? { ...copy, signal } : copy
}
