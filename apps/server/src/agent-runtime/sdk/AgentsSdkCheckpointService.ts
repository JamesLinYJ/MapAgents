// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK opaque checkpoint 服务
//
//   文件:       AgentsSdkCheckpointService.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { Agent } from '@openai/agents'

import type { RunSteeringRecord } from '../../schemas/types.js'
import type { AgentRuntimeStore } from '../../store/runtimePorts.js'
import type { AgentsExecutionContext } from '../../agent/agentsToolBridge.js'
import { SDK_STATE_SCHEMA_VERSION } from '../../agent/agentsRuntimeMetadata.js'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'
import { AgentsSdkBridge, type AgentsSdkState } from './AgentsSdkBridge.js'
import {
  AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
  AgentsSdkCheckpointCodec,
  type AgentsSdkCheckpointEnvelope,
} from './AgentsSdkCheckpointCodec.js'

type SupervisorAgent = Agent<AgentsExecutionContext>

export interface RestoreAgentsCheckpointOptions {
  runId: string
  agent: SupervisorAgent
  context: AgentsExecutionContext
  sdkVersion: string
  configDigest: string
}

export interface AgentsCheckpointCommit {
  acknowledgedInputs: RunSteeringRecord[]
  terminalToolCallIds: string[]
}

export interface RestoredAgentsCheckpoint {
  state: AgentsSdkState<AgentsExecutionContext>
  stepContext: RecordedAgentStepContext
}

export interface PersistAgentsCheckpointMetadata {
  sdkVersion: string
  configDigest: string
  stepContext: RecordedAgentStepContext
  terminalToolCallIds: readonly string[]
}

export class AgentsSdkCheckpointService {
  private readonly bridge = new AgentsSdkBridge()
  private readonly codec = new AgentsSdkCheckpointCodec()

  constructor(private readonly store: AgentRuntimeStore) {}

  async persist(
    runId: string,
    state: AgentsSdkState<AgentsExecutionContext>,
    metadata: PersistAgentsCheckpointMetadata,
    inputLeaseId: string | null = null,
  ): Promise<AgentsCheckpointCommit> {
    const checkpoint = await this.store.getRunCheckpoint(runId)
    const inputCursor = checkpointCursorAfterCommit(checkpoint, inputLeaseId)
    const terminalToolCallIds = [...new Set(metadata.terminalToolCallIds)]
    const serializedEnvelope = this.codec.encode({
      envelopeVersion: AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
      publicSerializedState: this.bridge.serialize(state),
      sdkVersion: metadata.sdkVersion,
      sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
      runtimeConfigDigest: metadata.configDigest,
      toolPlanDigest: metadata.stepContext.toolPlanDigest,
      worldRevision: metadata.stepContext.worldRevision,
      inputCursor,
      segmentId: metadata.stepContext.identity.segmentId,
    })
    const acknowledgedInputs = await this.store.saveAgentsSdkCheckpointEnvelope(runId, serializedEnvelope, {
      agentsSdkVersion: metadata.sdkVersion,
      runtimeConfigDigest: metadata.configDigest,
      inputLeaseId,
      terminalToolCallIds,
    })
    return { acknowledgedInputs, terminalToolCallIds }
  }

  async restore(
    options: RestoreAgentsCheckpointOptions,
  ): Promise<RestoredAgentsCheckpoint> {
    const checkpoint = await this.store.getRunCheckpoint(options.runId)
    assertCheckpointCompatibility(checkpoint, {
      runId: options.runId,
      sdkVersion: options.sdkVersion,
      configDigest: options.configDigest,
    })
    const envelope = this.codec.decode(await this.store.readAgentsSdkCheckpointEnvelope(options.runId))
    assertEnvelopeCompatibility(envelope, checkpoint, options)
    return {
      state: await this.bridge.restore({
        agent: options.agent,
        context: options.context,
        publicSerializedState: envelope.publicSerializedState,
      }),
      stepContext: {
        identity: { segmentId: envelope.segmentId },
        toolPlanDigest: envelope.toolPlanDigest,
        worldRevision: envelope.worldRevision,
      },
    }
  }

  async requireTurnId(threadId: string, runId: string): Promise<string> {
    const entries = await this.store.activeTranscript(threadId)
    const entry = [...entries].reverse().find(candidate => candidate.runId === runId && candidate.turnId)
    if (!entry?.turnId) throw new Error(`run '${runId}' 缺少可恢复 turnId`)
    return entry.turnId
  }
}

export function assertCheckpointCompatibility(
  checkpoint: {
    orchestrationEngine: string | null
    sdkStateSchemaVersion: number | null
    agentsSdkVersion: string | null
    runtimeConfigDigest: string | null
  },
  expected: { runId: string; sdkVersion: string; configDigest: string },
): void {
  if (checkpoint.orchestrationEngine !== 'openai_agents') {
    throw new Error(`run '${expected.runId}' 不是 OpenAI Agents SDK 检查点，不能续跑`)
  }
  if (checkpoint.sdkStateSchemaVersion !== SDK_STATE_SCHEMA_VERSION) {
    throw new Error(`run '${expected.runId}' SDK 状态 schema 不匹配`)
  }
  if (checkpoint.agentsSdkVersion !== expected.sdkVersion) {
    throw new Error(`run '${expected.runId}' SDK 版本不匹配：${checkpoint.agentsSdkVersion} != ${expected.sdkVersion}`)
  }
  if (checkpoint.runtimeConfigDigest !== expected.configDigest) {
    throw new Error(`run '${expected.runId}' 运行配置已变化，拒绝恢复`)
  }
}

function checkpointCursorAfterCommit(
  checkpoint: {
    checkpointInputCursor: number
    activeInputLeaseId: string | null
    activeInputLeaseTo: number | null
  },
  inputLeaseId: string | null,
): number {
  if (!inputLeaseId) return checkpoint.checkpointInputCursor
  if (checkpoint.activeInputLeaseId !== inputLeaseId || checkpoint.activeInputLeaseTo === null) {
    throw new Error(
      `输入 lease '${inputLeaseId}' 与活动 checkpoint lease `
      + `'${checkpoint.activeInputLeaseId ?? 'none'}' 不一致`,
    )
  }
  return checkpoint.activeInputLeaseTo
}

function assertEnvelopeCompatibility(
  envelope: AgentsSdkCheckpointEnvelope,
  checkpoint: {
    sdkStateSchemaVersion: number | null
    agentsSdkVersion: string | null
    runtimeConfigDigest: string | null
    checkpointInputCursor: number
  },
  expected: RestoreAgentsCheckpointOptions,
): void {
  if (envelope.sdkStateSchemaVersion !== checkpoint.sdkStateSchemaVersion) {
    throw new Error(`run '${expected.runId}' checkpoint envelope schema 与数据库不一致`)
  }
  if (envelope.sdkVersion !== checkpoint.agentsSdkVersion) {
    throw new Error(`run '${expected.runId}' checkpoint envelope SDK 版本与数据库不一致`)
  }
  if (envelope.runtimeConfigDigest !== checkpoint.runtimeConfigDigest) {
    throw new Error(`run '${expected.runId}' checkpoint envelope 配置摘要与数据库不一致`)
  }
  if (envelope.inputCursor !== checkpoint.checkpointInputCursor) {
    throw new Error(`run '${expected.runId}' checkpoint envelope input cursor 与数据库不一致`)
  }
}
