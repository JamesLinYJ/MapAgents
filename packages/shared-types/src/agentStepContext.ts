// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求级不可变 StepContext 契约
//
//   文件:       agentStepContext.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { geoWorldCapabilitiesSchema } from './geoWorld.js'
import { modelCapabilitySnapshotSchema } from './resources.js'

export const AGENT_STEP_CONTEXT_SCHEMA_VERSION = 1 as const

export const agentStepIdentitySchema = z.object({
  stepId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  segmentId: z.string().trim().min(1),
  modelRequestIndex: z.number().int().positive(),
}).strict()

export const agentToolPlanEntrySchema = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(['platform', 'subagent', 'handoff', 'mcp', 'hosted', 'sandbox']),
  providerId: z.string().trim().min(1).nullable(),
  schemaDigest: z.string().trim().min(1),
  definitionDigest: z.string().trim().min(1),
  requiresApproval: z.boolean(),
  readOnly: z.boolean().nullable(),
  destructive: z.boolean().nullable(),
}).strict()

export const agentToolPlanSnapshotSchema = z.object({
  entries: z.array(agentToolPlanEntrySchema),
  catalogDigest: z.string().trim().min(1),
}).strict().superRefine((plan, context) => {
  const names = new Set<string>()
  for (const [index, entry] of plan.entries.entries()) {
    if (names.has(entry.name)) {
      context.addIssue({ code: 'custom', path: ['entries', index, 'name'], message: '模型可见工具名不能重复' })
    }
    names.add(entry.name)
  }
})

export const agentPermissionSnapshotSchema = z.object({
  principalId: z.string().trim().min(1).nullable(),
  workspaceId: z.string().trim().min(1),
  roles: z.array(z.string().trim().min(1)),
  toolRules: z.array(z.object({
    toolPattern: z.string().trim().min(1),
    decision: z.enum(['always_allow', 'always_deny', 'always_ask']),
    priority: z.number(),
  }).strict()),
}).strict()

export const agentApprovalPolicySnapshotSchema = z.object({
  interruptToolNames: z.array(z.string().trim().min(1)),
  destructiveToolsRequireApproval: z.literal(true),
}).strict()

export const agentSandboxSnapshotSchema = z.object({
  backend: z.string().trim().min(1),
  writableRoots: z.array(z.string().trim().min(1)),
  networkPolicy: z.string().trim().min(1),
}).strict()

export const agentMcpSnapshotSchema = z.object({
  servers: z.array(z.object({
    name: z.string().trim().min(1),
    transport: z.enum(['streamable_http', 'sse', 'stdio']),
    approval: z.enum(['always', 'never']),
    toolNames: z.array(z.string().trim().min(1)),
  }).strict()),
}).strict()

export const agentSkillSnapshotSchema = z.object({
  skillIds: z.array(z.string().trim().min(1)),
  catalogDigest: z.string().trim().min(1),
}).strict()

export const agentPluginSnapshotSchema = z.object({
  pluginIds: z.array(z.string().trim().min(1)),
  catalogDigest: z.string().trim().min(1),
}).strict()

export const agentWorldSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  stateDigest: z.string().trim().min(1),
  layerIds: z.array(z.string().trim().min(1)),
  datasetIds: z.array(z.string().trim().min(1)),
  fileIds: z.array(z.string().trim().min(1)),
  artifactIds: z.array(z.string().trim().min(1)),
  valueRefIds: z.array(z.string().trim().min(1)),
  capabilities: geoWorldCapabilitiesSchema,
}).strict()

export const agentStepContextSchema = z.object({
  schemaVersion: z.literal(AGENT_STEP_CONTEXT_SCHEMA_VERSION),
  identity: agentStepIdentitySchema,
  runId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  objectiveRevision: z.number().int().positive(),
  inputCursor: z.number().int().nonnegative(),
  model: z.object({
    provider: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    transport: z.enum(['responses', 'chat_completions']),
    capabilities: modelCapabilitySnapshotSchema,
    reasoningEffort: z.string().trim().min(1).nullable(),
    serviceTier: z.string().trim().min(1).nullable(),
    timeoutMs: z.number().int().nonnegative(),
  }).strict(),
  runtimeConfigDigest: z.string().trim().min(1),
  toolPlanDigest: z.string().trim().min(1),
  worldRevision: z.number().int().positive(),
  contextWindowId: z.string().trim().min(1),
  permissions: agentPermissionSnapshotSchema,
  approvalPolicy: agentApprovalPolicySnapshotSchema,
  sandbox: agentSandboxSnapshotSchema,
  mcp: agentMcpSnapshotSchema,
  skills: agentSkillSnapshotSchema,
  plugins: agentPluginSnapshotSchema,
  tools: agentToolPlanSnapshotSchema,
  world: agentWorldSnapshotSchema,
  capturedAt: z.string().datetime({ offset: true }),
  contextDigest: z.string().trim().min(1),
}).strict().superRefine((context, refinement) => {
  if (context.turnId !== context.identity.turnId) {
    refinement.addIssue({ code: 'custom', path: ['turnId'], message: 'turnId 必须与 identity.turnId 一致' })
  }
  if (context.toolPlanDigest !== context.tools.catalogDigest) {
    refinement.addIssue({ code: 'custom', path: ['toolPlanDigest'], message: 'toolPlanDigest 必须绑定当前工具计划' })
  }
  if (context.worldRevision !== context.world.revision) {
    refinement.addIssue({ code: 'custom', path: ['worldRevision'], message: 'worldRevision 必须绑定当前世界快照' })
  }
  if (context.model.modelId !== context.model.capabilities.modelId) {
    refinement.addIssue({ code: 'custom', path: ['model', 'modelId'], message: 'modelId 必须与能力快照一致' })
  }
})

export type AgentStepIdentity = z.infer<typeof agentStepIdentitySchema>
export type AgentToolPlanEntry = z.infer<typeof agentToolPlanEntrySchema>
export type AgentToolPlanSnapshot = z.infer<typeof agentToolPlanSnapshotSchema>
export type AgentPermissionSnapshot = z.infer<typeof agentPermissionSnapshotSchema>
export type AgentApprovalPolicySnapshot = z.infer<typeof agentApprovalPolicySnapshotSchema>
export type AgentSandboxSnapshot = z.infer<typeof agentSandboxSnapshotSchema>
export type AgentMcpSnapshot = z.infer<typeof agentMcpSnapshotSchema>
export type AgentSkillSnapshot = z.infer<typeof agentSkillSnapshotSchema>
export type AgentPluginSnapshot = z.infer<typeof agentPluginSnapshotSchema>
export type AgentWorldSnapshot = z.infer<typeof agentWorldSnapshotSchema>
export type AgentStepContext = z.infer<typeof agentStepContextSchema>
