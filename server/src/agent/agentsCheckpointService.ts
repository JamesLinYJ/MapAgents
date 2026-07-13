// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 检查点服务
//
//   文件:       agentsCheckpointService.ts
// --------------------------------------------------------------------------

import { Agent, RunContext, RunState } from '@openai/agents'

import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'

export interface RestoreAgentsCheckpointOptions {
  runId: string
  agent: Agent<AgentsExecutionContext>
  context: AgentsExecutionContext
  sdkVersion: string
  configDigest: string
}

export class AgentsCheckpointService {
  constructor(private readonly store: AgentRuntimeStore) {}

  async persist(
    runId: string,
    state: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>,
    metadata: { sdkVersion: string; configDigest: string },
  ): Promise<void> {
    await this.store.saveAgentsSdkState(runId, state.toString(), {
      agentsSdkVersion: metadata.sdkVersion,
      runtimeConfigDigest: metadata.configDigest,
    })
  }

  async restore(
    options: RestoreAgentsCheckpointOptions,
  ): Promise<RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>>> {
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
