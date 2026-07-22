import type { Agent, Runner } from '@openai/agents'
import type { SandboxSessionLike } from '@openai/agents/sandbox'

import type { AgentRuntimeConfig, supervisorDeliverySchema } from '@geo-agent-platform/shared-types/runtime'
import type { ModelAdapter } from '../model/registry.js'
import type { AuthContext } from '../security/types.js'
import type { FileAgentsSession } from './fileAgentsSession.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RuntimeSdkIntegration } from './runtimeSdkIntegrations.js'

export interface RunOptions {
  runId: string
  threadId?: string | null
  sessionId: string
  query: string
  provider: string
  modelName?: string | null
  runtimeConfig: AgentRuntimeConfig
  executionMode?: 'plan' | 'auto'
  reasoning?: boolean
  resume?: boolean
  auth?: AuthContext | null
  signal?: AbortSignal
}

export interface RuntimeAssembly {
  agent: Agent<AgentsExecutionContext, typeof supervisorDeliverySchema>
  runner: Runner
  session: FileAgentsSession
  context: AgentsExecutionContext
  coordinator: ToolExecutionCoordinator
  adapter: ModelAdapter
  sandboxSession: SandboxSessionLike
  sdkIntegration: RuntimeSdkIntegration
  configDigest: string
  sdkVersion: string
  threadId: string
  turnId: string
  subAgentToolNames: ReadonlySet<string>
  handoffToolNames: ReadonlySet<string>
  handoffAgentNames: ReadonlySet<string>
  mcpToolNames: ReadonlySet<string>
  completeHandoff: (agentId: string, summary: string) => Promise<void>
  failHandoff: (agentId: string, message: string) => Promise<void>
  flushPendingSessionAssistantMessage: () => Promise<void>
  discardPendingSessionAssistantMessage: () => void
}

export interface StreamProjectionState {
  assistantItemId: string | null
  reasoningItemId: string | null
  /** 原始供应商推理只用于同一 SDK run 的协议回放，不进入用户时间线。 */
  reasoningText: string
  visibleReasoningText: string
  reasoningPass: number
  lastAssistantText: string
  completedAssistantItems: Array<{ itemId: string; text: string; entryId: string | null }>
  subAgentCallItemIds: Map<string, string>
}
