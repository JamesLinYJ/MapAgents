// GeoForge 平台资源协议：身份、会话、线程、运行与气象数据索引。
import { z } from 'zod'
import type { AgentRuntimeConfig } from './runtime.js'
import { agentStateSchema, runStatusSchema, toolValueRefSchema } from './core.js'

// --- Session / Thread / Run ---

export const platformRoleSchema = z.enum(['platform_admin', 'workspace_admin', 'analyst', 'viewer'])
export const resourceVisibilitySchema = z.enum(['private', 'workspace', 'public']).default('workspace')

export const platformUserSchema = z.object({
  userId: z.string(),
  subject: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'disabled']).default('active'),
  lastLoginAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const platformWorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  status: z.enum(['active', 'archived']).default('active'),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const platformMembershipSchema = z.object({
  membershipId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: platformRoleSchema,
  createdAt: z.string(),
})

export const authMeSchema = z.object({
  user: platformUserSchema,
  defaultWorkspace: platformWorkspaceSchema.nullable().default(null),
  memberships: z.array(platformMembershipSchema).default([]),
  platformRoles: z.array(platformRoleSchema).default([]),
  csrfToken: z.string(),
  permissions: z.array(z.string()).default([]),
})

export const auditEventSchema = z.object({
  auditEventId: z.string(),
  actorUserId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string().nullable().default(null),
  outcome: z.enum(['allowed', 'denied', 'error']).default('allowed'),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
})

export const sessionRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  createdAt: z.string(),
  status: z.string().default('active'),
  shareToken: z.string(),
  latestThreadId: z.string().nullable().default(null),
  latestRunId: z.string().nullable().default(null),
  latestUploadedLayerKey: z.string().nullable().default(null),
  latestMeteorologicalDatasetId: z.string().nullable().default(null),
})

export const meteorologicalDatasetRecordSchema = z.object({
  datasetId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  filename: z.string(),
  originalFilename: z.string(),
  fileId: z.string().nullable().default(null),
  fileRelativePath: z.string(),
  sizeBytes: z.number().int().nonnegative().default(0),
  contentHash: z.string().nullable().default(null),
  mediaType: z.string().default('application/octet-stream'),
  status: z.string().default('ready'),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const meteorologicalJobRecordSchema = z.object({
  jobId: z.string(),
  datasetId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  kind: z.string(),
  status: z.string(),
  message: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
})

export const agentThreadRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  title: z.string(),
  status: z.string().default('active'),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRunId: z.string().nullable().default(null),
  latestUserQuery: z.string().nullable().default(null),
  latestAssistantSummary: z.string().nullable().default(null),
  latestRunStatus: z.string().nullable().default(null),
  latestArtifactId: z.string().nullable().default(null),
  latestArtifactName: z.string().nullable().default(null),
  historyPreview: z.string().nullable().default(null),
  runCount: z.number().default(0),
  conversationPath: z.string().nullable().default(null),
})

export const analysisRunSchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema.default('queued'),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: agentStateSchema,
  conversationPath: z.string().nullable().default(null),
  runtimeConfigSnapshot: z.custom<AgentRuntimeConfig>().nullable().default(null),
})

export const directToolResultSchema = z.object({
  message: z.string(),
  payload: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  resultId: z.string(),
  source: z.string(),
  valueRefs: z.array(toolValueRefSchema).optional(),
  artifacts: z.array(z.object({
    artifactId: z.string(),
    artifactType: z.string(),
    name: z.string(),
    uri: z.string(),
    relativePath: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
})

export const directToolRunResponseSchema = z.object({
  result: directToolResultSchema,
  run: analysisRunSchema,
})

// 运行历史列表只传输稳定摘要，不把完整 AgentState、事件和消息带入列表请求。
export const runSummarySchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  artifactCount: z.number().int().nonnegative().default(0),
  latestArtifactId: z.string().nullable().default(null),
  latestArtifactName: z.string().nullable().default(null),
})

export type PlatformRole = z.infer<typeof platformRoleSchema>
export type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>
export type PlatformUser = z.infer<typeof platformUserSchema>
export type PlatformWorkspace = z.infer<typeof platformWorkspaceSchema>
export type PlatformMembership = z.infer<typeof platformMembershipSchema>
export type AuthMe = z.infer<typeof authMeSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type MeteorologicalDatasetRecord = z.infer<typeof meteorologicalDatasetRecordSchema>
export type MeteorologicalJobRecord = z.infer<typeof meteorologicalJobRecordSchema>
export type AgentThreadRecord = z.infer<typeof agentThreadRecordSchema>
export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type DirectToolResult = z.infer<typeof directToolResultSchema>
export type DirectToolRunResponse = z.infer<typeof directToolRunResponseSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type AgentExecutionMode = 'plan' | 'auto'
