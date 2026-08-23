// +-------------------------------------------------------------------------
//
//   地理智能平台 - StepContext 测试记录器
//
//   文件:       agentStepContextRecorder.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  AGENT_STEP_CONTEXT_SCHEMA_VERSION,
  agentStepContextSchema,
  type AgentStepContext,
} from '@geo-agent-platform/shared-types/agent-step-context'

import { agentContextDigest } from '../src/agent-runtime/step/agentContextDigest.js'
import type {
  AgentStepContextRecorder,
  CaptureAgentStepContextInput,
} from '../src/agent-runtime/step/AgentStepContextFactory.js'

interface TestStepContextRecorderOptions {
  onRecord?: (input: CaptureAgentStepContextInput) => void
}

export function createTestAgentStepContextRecorder(
  options: TestStepContextRecorderOptions = {},
): AgentStepContextRecorder {
  const contexts = new Map<string, AgentStepContext>()
  let modelRequestIndex = 0
  return {
    record: async input => {
      options.onRecord?.(input)
      const context = createTestAgentStepContext(input, ++modelRequestIndex)
      contexts.set(context.identity.stepId, context)
      return context
    },
    get: async stepId => contexts.get(stepId) ?? null,
  }
}

function createTestAgentStepContext(
  input: CaptureAgentStepContextInput,
  modelRequestIndex: number,
): AgentStepContext {
  const capturedAt = '2026-08-23T00:00:00.000Z'
  const identity = {
    stepId: `step_test_${modelRequestIndex}`,
    turnId: input.turnId,
    segmentId: input.segmentId,
    modelRequestIndex,
  }
  const capabilities = {
    toolNames: input.toolPlan.entries.map(entry => entry.name).sort(),
    mcpServerNames: [...new Set(input.activeMcpServers)].sort(),
    sandboxBackend: input.runtimeConfig.sandbox.backend,
    writableRoots: input.runtimeConfig.developer.enabled
      ? [...new Set(input.runtimeConfig.developer.allowedRoots)].sort()
      : [],
    networkPolicy: input.runtimeConfig.sandbox.backend === 'disabled'
      ? 'provider_and_registered_tools'
      : 'sandbox_manifest',
  }
  const contextWithoutDigest = {
    schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    identity,
    runId: input.runId,
    turnId: input.turnId,
    objectiveRevision: input.objectiveRevision,
    inputCursor: input.inputCursor,
    model: {
      provider: input.provider,
      modelId: input.modelId,
      transport: typeof input.transport === 'string' && input.transport.includes('chat')
        ? 'chat_completions' as const
        : 'responses' as const,
      capabilities: input.modelCapabilities,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      timeoutMs: input.timeoutMs,
    },
    runtimeConfigDigest: input.runtimeConfigDigest,
    toolPlanDigest: input.toolPlan.catalogDigest,
    worldRevision: 1,
    contextWindowId: `context_window_test_${modelRequestIndex}`,
    permissions: {
      principalId: input.auth?.userId ?? null,
      workspaceId: input.auth?.defaultWorkspaceId ?? 'workspace_test',
      roles: [],
      toolRules: [],
    },
    approvalPolicy: {
      interruptToolNames: [...input.runtimeConfig.supervisor.approvalInterruptTools].sort(),
      destructiveToolsRequireApproval: true as const,
    },
    sandbox: {
      backend: input.runtimeConfig.sandbox.backend,
      writableRoots: capabilities.writableRoots,
      networkPolicy: capabilities.networkPolicy,
    },
    mcp: input.mcpBinding,
    skills: {
      skillIds: [...new Set(input.activeSkills)].sort(),
      invocations: [...input.skillInvocations],
      catalogDigest: agentContextDigest(
        input.skillInvocations.length
          ? input.skillInvocations
          : [...new Set(input.activeSkills)].sort(),
      ),
    },
    plugins: input.pluginSnapshot,
    tools: input.toolPlan,
    world: {
      revision: 1,
      stateDigest: agentContextDigest({ runId: input.runId, revision: 1, capabilities }),
      layerIds: [],
      datasetIds: [],
      fileIds: [],
      artifactIds: [],
      valueRefIds: [],
      capabilities,
    },
    capturedAt,
  }
  return deepFreeze(agentStepContextSchema.parse({
    ...contextWithoutDigest,
    contextDigest: agentContextDigest(contextWithoutDigest),
  }))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
