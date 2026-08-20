// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 检查点服务
//
//   文件:       agentsCheckpointService.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Agent, RunContext, RunState } from '@openai/agents'

import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { toolCallResultIdsFromHistory } from './agentsSdkStateBoundary.js'
import { SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'
import type { RunSteeringRecord } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'

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

export class AgentsCheckpointService {
  constructor(private readonly store: AgentRuntimeStore) {}

  async persist(
    runId: string,
    state: RunState<AgentsExecutionContext, SupervisorAgent>,
    metadata: { sdkVersion: string; configDigest: string },
    inputLeaseId: string | null = null,
  ): Promise<AgentsCheckpointCommit> {
    const serializedState = state.toString()
    const terminalToolCallIds = toolCallResultIdsFromHistory(state.history)
    const acknowledgedInputs = await this.store.saveAgentsSdkState(runId, serializedState, {
      agentsSdkVersion: metadata.sdkVersion,
      runtimeConfigDigest: metadata.configDigest,
      inputLeaseId,
      terminalToolCallIds,
    })
    return { acknowledgedInputs, terminalToolCallIds }
  }

  async restore(
    options: RestoreAgentsCheckpointOptions,
  ): Promise<RunState<AgentsExecutionContext, SupervisorAgent>> {
    const checkpoint = await this.store.getRunCheckpoint(options.runId)
    assertCheckpointCompatibility(checkpoint, {
      runId: options.runId,
      sdkVersion: options.sdkVersion,
      configDigest: options.configDigest,
    })
    const serialized = await this.store.readAgentsSdkState(options.runId)
    return RunState.fromStringWithContext(
      options.agent,
      serialized,
      new RunContext(options.context),
      { contextStrategy: 'replace' },
    )
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
