// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 资源与控制面协议
//
//   文件:       resources.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { z } from 'zod'
import { runStatusSchema } from './core.js'
import { resourceVisibilitySchema } from './platform.js'

// --- Resources ---

export const layerPropertyDescriptorSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  populatedCount: z.number().default(0),
  sampleValues: z.array(z.string()).default([]),
})

export const layerDescriptorSchema = z.object({
  mapLayerId: z.string().trim().min(1),
  layerKey: z.string(),
  name: z.string(),
  sourceType: z.string(),
  geometryType: z.string(),
  srid: z.number().default(4326),
  description: z.string(),
  featureCount: z.number().nullable().default(null),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  propertySchema: z.array(layerPropertyDescriptorSchema).default([]),
  category: z.string().default('general'),
  status: z.string().default('active'),
  tags: z.array(z.string()).default([]),
  analysisCapabilities: z.array(z.string()).default([]),
  sourceConfigSummary: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  readonly: z.boolean().default(false),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const basemapDescriptorSchema = z.object({
  basemapKey: z.string(),
  name: z.string(),
  provider: z.string(),
  kind: z.string(),
  attribution: z.string().default(''),
  tileUrls: z.array(z.string()).default([]),
  labelTileUrls: z.array(z.string()).default([]),
  available: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})

export const modelProviderDescriptorSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  configured: z.boolean(),
  defaultModel: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  contextWindowTokens: z.number().int().positive().default(128000),
})

export const speechLanguageOptionSchema = z.object({
  locale: z.string(),
  label: z.string(),
})

export const speechAuthorizationSchema = z.object({
  authorizationToken: z.string(),
  region: z.string(),
  endpoint: z.string(),
  expiresAt: z.string(),
  defaultLanguage: z.string(),
  supportedLanguages: z.array(speechLanguageOptionSchema).default([]),
})

export const systemComponentsStatusSchema = z.object({
  catalogBackend: z.string(),
  postgisEnabled: z.boolean(),
  postgisError: z.string().nullable().default(null),
  payloadStoreRoot: z.string().nullable().default(null),
  providers: z.array(modelProviderDescriptorSchema).default([]),
  toolProviders: z.array(z.object({
    providerId: z.string(),
    name: z.string(),
    version: z.string().nullable().default(null),
    author: z.string().nullable().default(null),
    language: z.string().nullable().default(null),
    toolCount: z.number().default(0),
    available: z.boolean(),
    error: z.string().nullable(),
  })).default([]),
})

export const toolParameterOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
})

export const toolParameterDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  dataType: z.string(),
  source: z.string().default('text'),
  required: z.boolean().default(false),
  description: z.string().nullable().default(null),
  placeholder: z.string().nullable().default(null),
  defaultValue: z.unknown().nullable().default(null),
  options: z.array(toolParameterOptionSchema).default([]),
  acceptedValueRefKinds: z.array(z.string()).default([]),
})

export const toolDescriptorSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  toolKind: z.string().default('registry'),
  providerId: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  isReadOnly: z.boolean().default(true),
  isDestructive: z.boolean().default(false),
  available: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  parameters: z.array(toolParameterDescriptorSchema).default([]),
  error: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).prefault({}),
})

export const workflowNodeTypeSchema = z.enum([
  'trigger',
  'tool',
  'agent',
  'condition',
  'approval',
  'output',
])

export const workflowBindingSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('literal'), value: z.unknown() }),
  z.object({ source: z.literal('input'), path: z.string().min(1) }),
  z.object({ source: z.literal('node'), nodeId: z.string().min(1), path: z.string().min(1) }),
])

export const workflowRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  backoffSeconds: z.number().int().min(0).max(300).default(0),
})

const workflowNodeBaseSchema = z.object({
  nodeId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  position: z.object({ x: z.number(), y: z.number() }),
})

export const workflowTriggerNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('trigger'),
  config: z.object({}),
})

export const workflowToolNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('tool'),
  config: z.object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), workflowBindingSchema).prefault({}),
    approvalMode: z.enum(['auto', 'always']).default('auto'),
    retry: workflowRetryPolicySchema.default({ maxAttempts: 1, backoffSeconds: 0 }),
  }),
})

export const workflowAgentNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('agent'),
  config: z.object({
    promptTemplate: z.string().min(1),
    executionMode: z.enum(['auto', 'plan']).default('auto'),
    reasoning: z.boolean().default(true),
    retry: workflowRetryPolicySchema.default({ maxAttempts: 1, backoffSeconds: 0 }),
  }),
})

export const workflowConditionNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('condition'),
  config: z.object({
    left: workflowBindingSchema,
    operator: z.enum(['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'contains', 'exists', 'is_true']),
    right: workflowBindingSchema.nullable().default(null),
  }),
})

export const workflowApprovalNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('approval'),
  config: z.object({
    title: z.string().min(1),
    question: z.string().min(1),
    description: z.string().default(''),
  }),
})

export const workflowOutputNodeSchema = workflowNodeBaseSchema.extend({
  type: z.literal('output'),
  config: z.object({
    outputs: z.record(z.string(), workflowBindingSchema).prefault({}),
  }),
})

export const workflowNodeSchema = z.discriminatedUnion('type', [
  workflowTriggerNodeSchema,
  workflowToolNodeSchema,
  workflowAgentNodeSchema,
  workflowConditionNodeSchema,
  workflowApprovalNodeSchema,
  workflowOutputNodeSchema,
])

export const workflowEdgePortSchema = z.enum([
  'default',
  'success',
  'error',
  'true',
  'false',
  'approved',
  'rejected',
])

export const workflowEdgeSchema = z.object({
  edgeId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  sourcePort: workflowEdgePortSchema.default('default'),
})

export const workflowGraphSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  entryNodeId: z.string().min(1),
  nodes: z.array(workflowNodeSchema).min(2),
  edges: z.array(workflowEdgeSchema).min(1),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  }).default({ x: 0, y: 0, zoom: 1 }),
})

export const workflowDefinitionSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  revision: z.number().int().positive().default(1),
  publishedRevision: z.number().int().positive().nullable().default(null),
  source: z.enum(['builtin', 'workspace']).default('builtin'),
  lifecycle: z.enum(['draft', 'published', 'disabled']).default('published'),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  parametersSchema: z.record(z.string(), z.unknown()).prefault({}),
  defaultParameters: z.record(z.string(), z.unknown()).prefault({}),
  requiredTools: z.array(z.string()).default([]),
  requiresApproval: z.boolean().default(false),
  timeoutSeconds: z.number().int().positive().default(900),
  outputType: z.string().default('conversation'),
  graph: workflowGraphSchema,
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const workflowValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().nullable().default(null),
  edgeId: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
})

export const workflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(workflowValidationIssueSchema),
  topologicalOrder: z.array(z.string()),
  requiredTools: z.array(z.string()),
})

export const workflowVersionRecordSchema = z.object({
  workflowId: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.enum(['draft', 'published', 'archived']),
  definition: workflowDefinitionSchema,
  createdByUserId: z.string().nullable().default(null),
  createdAt: z.string(),
  publishedAt: z.string().nullable().default(null),
})

export const workflowNodeRunSchema = z.object({
  nodeId: z.string(),
  nodeType: workflowNodeTypeSchema,
  label: z.string(),
  status: z.enum(['pending', 'running', 'waiting_approval', 'completed', 'skipped', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative().default(0),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  output: z.record(z.string(), z.unknown()).prefault({}),
})

export const workflowApprovalRequestSchema = z.object({
  approvalId: z.string(),
  nodeId: z.string(),
  title: z.string(),
  question: z.string(),
  description: z.string().default(''),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
  resolvedByUserId: z.string().nullable().default(null),
})

export const scheduledTaskSchema = z.object({
  taskId: z.string(),
  targetKind: z.enum(['workflow']),
  targetId: z.string(),
  workspaceId: z.string(),
  createdByUserId: z.string(),
  title: z.string(),
  prompt: z.string(),
  parameters: z.record(z.string(), z.unknown()).prefault({}),
  cron: z.string(),
  timezone: z.string(),
  recurring: z.boolean().default(true),
  enabled: z.boolean().default(true),
  status: z.enum(['active', 'paused', 'missed', 'failed', 'deleted']).default('active'),
  lastFiredAt: z.string().nullable().default(null),
  nextFireAt: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  queueJobId: z.string().nullable().default(null),
  failureCount: z.number().int().nonnegative().default(0),
  lastErrorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const workflowRunRecordSchema = z.object({
  workflowRunId: z.string(),
  workflowId: z.string(),
  scheduledTaskId: z.string().nullable().default(null),
  workspaceId: z.string(),
  createdByUserId: z.string(),
  runId: z.string().nullable().default(null),
  workflowRevision: z.number().int().positive().default(1),
  status: z.enum(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled']).default('queued'),
  currentStep: z.string().nullable().default(null),
  triggerKind: z.enum(['manual', 'schedule']).default('manual'),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  nodeRuns: z.array(workflowNodeRunSchema).default([]),
  pendingApproval: workflowApprovalRequestSchema.nullable().default(null),
  outputs: z.record(z.string(), z.unknown()).prefault({}),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
})

export const backgroundTaskInfoSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  label: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  workspaceId: z.string().nullable().default(null),
  userId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
})

export const tokenUsageTotalsSchema = z.object({
  runCount: z.number().int().nonnegative(),
  runsWithUsage: z.number().int().nonnegative(),
  runsWithoutUsage: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheHitInputTokens: z.number().int().nonnegative(),
  cacheHitReportedRuns: z.number().int().nonnegative(),
  cacheHitUnreportedRuns: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextEstimatedTokens: z.number().int().nonnegative(),
})

export const tokenUsageBucketSchema = tokenUsageTotalsSchema.extend({
  key: z.string(),
  label: z.string(),
})

export const tokenUsageRunSchema = z.object({
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheHitInputTokens: z.number().int().nonnegative(),
  cacheHitReported: z.boolean(),
  totalTokens: z.number().int().nonnegative(),
  contextEstimatedTokens: z.number().int().nonnegative(),
  contextUsagePermille: z.number().int().nonnegative().nullable().default(null),
  usageResponseCount: z.number().int().nonnegative(),
  hasUsage: z.boolean(),
})

export const tokenUsageLimitSchema = z.object({
  period: z.enum(['day', 'month']),
  label: z.string(),
  enabled: z.boolean(),
  limitTokens: z.number().int().nonnegative().nullable().default(null),
  usedTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nullable().default(null),
  exceeded: z.boolean(),
  resetsAt: z.string(),
})

export const tokenUsageSummarySchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.string(),
  totals: tokenUsageTotalsSchema,
  limits: z.array(tokenUsageLimitSchema),
  byProvider: z.array(tokenUsageBucketSchema),
  byModel: z.array(tokenUsageBucketSchema),
  byStatus: z.array(tokenUsageBucketSchema),
  recentRuns: z.array(tokenUsageRunSchema),
  warnings: z.array(z.string()).default([]),
})

export type LayerPropertyDescriptor = z.infer<typeof layerPropertyDescriptorSchema>
export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>
export type BasemapDescriptor = z.infer<typeof basemapDescriptorSchema>
export type ModelProviderDescriptor = z.infer<typeof modelProviderDescriptorSchema>
export type SpeechLanguageOption = z.infer<typeof speechLanguageOptionSchema>
export type SpeechAuthorization = z.infer<typeof speechAuthorizationSchema>
export type SystemComponentsStatus = z.infer<typeof systemComponentsStatusSchema>
export type ToolParameterOption = z.infer<typeof toolParameterOptionSchema>
export type ToolParameterDescriptor = z.infer<typeof toolParameterDescriptorSchema>
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>
export type WorkflowBinding = z.infer<typeof workflowBindingSchema>
export type WorkflowRetryPolicy = z.infer<typeof workflowRetryPolicySchema>
export type WorkflowNode = z.infer<typeof workflowNodeSchema>
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>
export type WorkflowValidationIssue = z.infer<typeof workflowValidationIssueSchema>
export type WorkflowValidationResult = z.infer<typeof workflowValidationResultSchema>
export type WorkflowVersionRecord = z.infer<typeof workflowVersionRecordSchema>
export type WorkflowNodeRun = z.infer<typeof workflowNodeRunSchema>
export type WorkflowApprovalRequest = z.infer<typeof workflowApprovalRequestSchema>
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>
export type WorkflowRunRecord = z.infer<typeof workflowRunRecordSchema>
export type BackgroundTaskInfo = z.infer<typeof backgroundTaskInfoSchema>
export type TokenUsageTotals = z.infer<typeof tokenUsageTotalsSchema>
export type TokenUsageBucket = z.infer<typeof tokenUsageBucketSchema>
export type TokenUsageRun = z.infer<typeof tokenUsageRunSchema>
export type TokenUsageLimit = z.infer<typeof tokenUsageLimitSchema>
export type TokenUsageSummary = z.infer<typeof tokenUsageSummarySchema>
