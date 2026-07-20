import type { Agent, Runner } from '@openai/agents'
import type { SandboxSessionLike } from '@openai/agents/sandbox'

import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import type { ModelAdapter } from '../model/registry.js'
import type { AuthContext } from '../security/types.js'
import type { FileAgentsSession } from './fileAgentsSession.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RuntimeSdkToolIntegration } from './runtimeSdkIntegrations.js'

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
  agent: Agent<AgentsExecutionContext>
  runner: Runner
  session: FileAgentsSession
  context: AgentsExecutionContext
  coordinator: ToolExecutionCoordinator
  adapter: ModelAdapter
  sandboxSession: SandboxSessionLike
  sdkTools: RuntimeSdkToolIntegration
  configDigest: string
  sdkVersion: string
  threadId: string
  turnId: string
  subAgentNames: ReadonlySet<string>
  flushPendingSessionAssistantMessage: () => Promise<void>
}

export interface StreamProjectionState {
  assistantItemId: string | null
  reasoningItemId: string | null
  reasoningText: string
  lastAssistantText: string
  completedAssistantItems: Array<{ itemId: string; text: string; entryId: string | null }>
  subAgentCallItemIds: Map<string, string>
}
