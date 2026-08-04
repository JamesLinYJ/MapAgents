// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 与 WebSocket 传输协议
//
//   文件:       transport.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 HTTP/WS 传输投影协议。
import { z } from 'zod'
import {
  conversationItemSchema,
  runEventSchema,
  memoryFileRecordSchema,
  memorySearchResultSchema,
  runSteeringRecordSchema,
} from './core.js'
import {
  compactionRecordSchema,
  contextAssemblyReportSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  transcriptEntrySchema,
} from './conversation.js'
import {
  analysisRunSchema,
  agentThreadRecordSchema,
  authMeSchema,
  directToolRunResponseSchema,
  runSummarySchema,
  sessionRecordSchema,
} from './platform.js'
import { agentRuntimeConfigSchema } from './runtime.js'
import { mapSceneSchema, mapSceneUpdateSchema } from './map.js'
import {
  automationDefinitionSchema,
  automationAgentInvocationSchema,
  automationGraphSchema,
  automationRunRecordSchema,
  automationValidationResultSchema,
  automationVersionRecordSchema,
  backgroundTaskInfoSchema,
  layerDescriptorSchema,
  modelProviderDescriptorSchema,
  scheduledTaskSchema,
  speechAuthorizationSchema,
  systemComponentsStatusSchema,
  tokenUsageSummarySchema,
  toolDescriptorSchema,
} from './resources.js'

export const runSummaryPageSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})

export const workspaceBootstrapSnapshotSchema = z.object({
  auth: authMeSchema,
  session: sessionRecordSchema,
  threads: z.array(agentThreadRecordSchema),
  providers: z.array(modelProviderDescriptorSchema),
  tools: z.array(toolDescriptorSchema),
})

export const threadHistoryPageSchema = z.object({
  entries: z.array(transcriptEntrySchema),
  nextCursor: z.string().nullable(),
})

export const threadDetailSnapshotSchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
  runs: z.array(analysisRunSchema),
  latestRun: analysisRunSchema.nullable().optional(),
})

export const runSnapshotSchema = z.object({
  run: analysisRunSchema,
  items: z.array(conversationItemSchema),
  events: z.array(runEventSchema),
})

export type RunSummaryPage = z.infer<typeof runSummaryPageSchema>
export type WorkspaceBootstrapSnapshot = z.infer<typeof workspaceBootstrapSnapshotSchema>
export type ThreadHistoryPage = z.infer<typeof threadHistoryPageSchema>
export type ThreadDetailSnapshot = z.infer<typeof threadDetailSnapshotSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>

// --- WebSocket control plane ---

export const wsControlCommands = [
  'workspace:bootstrap',
  'session:get-default', 'session:get',
  'thread:list', 'thread:get', 'thread:create', 'thread:update', 'thread:delete',
  'thread:history', 'thread:fork', 'thread:compact', 'thread:context',
  'thread:subscribe', 'thread:unsubscribe',
  'thread:memory:get', 'thread:memory:update', 'thread:memory:rebuild',
  'thread:trash:list', 'thread:trash:restore', 'thread:trash:purge',
  'run:list', 'run:start', 'run:get', 'run:cancel', 'run:resume', 'run:steer', 'run:respond-decision', 'run:subscribe', 'run:unsubscribe',
  'tool:list', 'tool:run',
  'tool-catalog:list', 'tool-catalog:upsert', 'tool-catalog:delete',
  'runtime-config:get', 'runtime-config:update',
  'provider:list', 'system:get',
  'usage:summary',
  'speech:authorization',
  'memory:list', 'memory:read', 'memory:write', 'memory:delete', 'memory:search',
  'memory:extract', 'memory:dream',
  'memory:session:get', 'memory:session:rebuild',
  'memory:instructions:list',
  'file:list', 'file:delete',
  'layer:list', 'layer:update', 'layer:delete',
  'map-scene:update',
  'automation:list', 'automation:validate', 'automation:create', 'automation:update',
  'automation:publish', 'automation:disable', 'automation:history',
  'automation:start', 'automation:cancel', 'automation:run:get', 'automation:respond-approval',
  'scheduled-task:list', 'scheduled-task:create', 'scheduled-task:update', 'scheduled-task:delete',
  'background-task:list', 'background-task:promote', 'background-task:cancel',
] as const

export const wsControlCommandSchema = z.enum(wsControlCommands)
export type WsControlCommand = z.infer<typeof wsControlCommandSchema>

// --- WebSocket command contracts ---
//
// Payload/response schemas are kept beside the protocol command list so the
// server registry and the desktop Renderer cannot silently grow independent
// interpretations of the same command.  The schemas intentionally preserve
// the existing payload openness (passthrough where legacy clients relied on
// it); tightening a field is a protocol change and must be explicit.

const wsEmptyPayloadSchema = z.object({}).passthrough()
const wsSessionPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const wsThreadIdPayloadSchema = z.object({ threadId: z.string().min(1) }).passthrough()
const wsRunIdPayloadSchema = z.object({ runId: z.string().min(1) }).passthrough()
const wsAutomationIdPayloadSchema = z.object({ automationId: z.string().min(1) }).strict()
const wsAutomationRunIdPayloadSchema = z.object({ automationRunId: z.string().min(1) }).strict()
const wsTaskIdPayloadSchema = z.object({ taskId: z.string().min(1) }).strict()

const wsWorkspaceBootstrapPayloadSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  workspaceId: z.string().min(1).nullable().optional(),
}).passthrough()
const wsSessionGetPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const wsFileListPayloadSchema = z.object({ threadId: z.string().min(1) }).strict()
const wsFileDeletePayloadSchema = z.object({
  fileId: z.string().min(1),
  threadId: z.string().min(1),
}).strict()
const wsLayerListPayloadSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).passthrough()
const wsLayerUpdatePayloadSchema = z.object({
  layerKey: z.string().min(1),
  update: z.record(z.string(), z.unknown()),
}).passthrough()
const wsLayerDeletePayloadSchema = z.object({ layerKey: z.string().min(1) }).passthrough()
const wsRunListPayloadSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const wsRunStartPayloadSchema = z.object({
  query: z.string().min(1),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelProvider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
  executionMode: z.enum(['auto', 'plan']).optional(),
  reasoning: z.boolean().optional(),
}).passthrough()
const wsRunSteerPayloadSchema = z.object({
  runId: z.string().min(1),
  steeringId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const wsRespondDecisionPayloadSchema = z.object({
  runId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  text: z.string().nullable().optional(),
}).passthrough()
const wsThreadCreatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadUpdatePayloadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
}).passthrough()
const wsThreadHistoryPayloadSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const wsThreadForkPayloadSchema = z.object({
  threadId: z.string().min(1),
  entryId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadCompactPayloadSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadMemoryUpdatePayloadSchema = z.object({
  threadId: z.string().min(1),
  content: z.string(),
  expectedVersion: z.number().int().nonnegative().nullable().optional(),
}).passthrough()
const wsThreadMemoryRebuildPayloadSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryListPayloadSchema = z.object({ scope: z.string().min(1).nullable().optional() }).passthrough()
const wsMemoryReadDeletePayloadSchema = z.object({
  scope: z.string().min(1),
  relativePath: z.string().min(1),
}).passthrough()
const wsMemoryWritePayloadSchema = z.object({
  scope: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  content: z.string(),
  relativePath: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemorySearchPayloadSchema = z.object({
  query: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryExtractPayloadSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryDreamPayloadSchema = z.object({
  force: z.boolean().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsToolCatalogUpsertPayloadSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sortOrder: z.number().optional(),
}).passthrough()
const wsToolCatalogDeletePayloadSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
}).passthrough()
const wsRuntimeConfigUpdatePayloadSchema = z.object({
  config: agentRuntimeConfigSchema,
}).passthrough()
const wsToolRunPayloadSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  runId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).strict()
const wsAutomationDraftPayloadSchema = z.object({
  automationId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  parametersSchema: z.record(z.string(), z.unknown()),
  defaultParameters: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().int().positive().max(86_400),
  outputType: z.string().min(1),
  agentInvocation: automationAgentInvocationSchema.optional(),
  graph: automationGraphSchema,
}).strict()
const wsAutomationUpdatePayloadSchema = wsAutomationDraftPayloadSchema.extend({
  automationId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
}).strict()
const wsAutomationRevisionPayloadSchema = wsAutomationIdPayloadSchema.extend({ revision: z.number().int().positive() }).strict()
const wsAutomationStartPayloadSchema = z.object({
  automationId: z.string().min(1),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict()
const wsAutomationApprovalPayloadSchema = wsAutomationRunIdPayloadSchema.extend({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
}).strict()
const wsScheduledTaskCreatePayloadSchema = z.object({
  targetKind: z.literal('automation'),
  targetId: z.string().min(1),
  title: z.string().nullable().optional(),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()
const wsScheduledTaskUpdatePayloadSchema = wsScheduledTaskCreatePayloadSchema.partial().extend({
  taskId: z.string().min(1),
}).strict()

const wsUnknownRecordSchema = z.record(z.string(), z.unknown())
const wsMutationAckSchema = z.object({
  deleted: z.boolean().optional(),
  id: z.string().optional(),
  threadId: z.string().optional(),
  layerKey: z.string().optional(),
  purged: z.boolean().optional(),
  unsubscribed: z.boolean().optional(),
}).passthrough()
const wsFileEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number().nonnegative(),
  uploadedAt: z.string(),
  status: z.string(),
  threadId: z.string().nullable().optional(),
  relativePath: z.string().optional(),
  sourceRelativePath: z.string().nullable().optional(),
}).passthrough()
const wsFileListResponseSchema = z.object({
  files: z.array(wsFileEntrySchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsThreadTrashEntrySchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
  deletedAt: z.string(),
  purgeAfter: z.string(),
}).strict()
const wsThreadSubscriptionResponseSchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
}).strict()
const wsMemoryListResponseSchema = z.object({
  records: z.array(memoryFileRecordSchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsMemorySearchResponseSchema = z.object({
  matches: z.array(memorySearchResultSchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsDeletedMemorySchema = z.object({ deleted: z.boolean(), relativePath: z.string() }).strict()
const wsDreamMemoryResponseSchema = z.object({
  changed: z.boolean(),
  message: z.string(),
  records: z.array(memoryFileRecordSchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
}).strict()
const wsInstructionMemoryResponseSchema = z.object({
  enabled: z.boolean(),
  entrypointName: z.string(),
  records: z.array(memoryFileRecordSchema),
}).strict()
const wsDesktopWorkspaceBootstrapAuthSchema = authMeSchema
  .omit({ csrfToken: true })
  .extend({ requestProtection: z.literal('main_managed') })
  .strict()
const wsWorkspaceBootstrapResponseSchema = workspaceBootstrapSnapshotSchema
  .extend({ auth: z.union([authMeSchema, wsDesktopWorkspaceBootstrapAuthSchema]) })
  .strict()
const wsAutomationListResponseSchema = z.object({
  definitions: z.array(automationDefinitionSchema),
  diagnostics: z.array(wsUnknownRecordSchema),
  validation: z.record(z.string(), automationValidationResultSchema),
}).strict()
const wsAutomationStartResponseSchema = z.object({
  automationRun: automationRunRecordSchema,
  jobId: z.string(),
}).strict()
const wsAutomationApprovalResponseSchema = z.object({
  automationRun: automationRunRecordSchema,
  jobId: z.string().nullable(),
}).strict()
const wsScheduledTaskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
  automationRuns: z.array(automationRunRecordSchema),
}).strict()
const wsBackgroundTaskListResponseSchema = z.object({
  tasks: z.array(backgroundTaskInfoSchema),
}).strict()

export type WsCommandSemantic = {
  auth: 'required' | 'optional'
  csrf: boolean
  category: 'read' | 'write' | 'admin'
}

export type WsCommandContract = WsCommandSemantic & {
  payload: z.ZodTypeAny
  response: z.ZodTypeAny
}

const readContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = false,
): WsCommandSemantic & { payload: TPayload; response: TResponse } => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'read',
})
const writeContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = true,
): WsCommandSemantic & { payload: TPayload; response: TResponse } => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'write',
})
const adminContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = false,
): WsCommandSemantic & { payload: TPayload; response: TResponse } => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'admin',
})

// Every value in wsControlCommands has one entry.  Keeping this assertion
// adjacent to the protocol enum makes an omitted contract a compile error.
export const wsCommandContracts = {
  'workspace:bootstrap': adminContract(wsWorkspaceBootstrapPayloadSchema, wsWorkspaceBootstrapResponseSchema),
  'session:get-default': readContract(wsEmptyPayloadSchema, sessionRecordSchema),
  'session:get': readContract(wsSessionGetPayloadSchema, sessionRecordSchema),
  'thread:list': readContract(wsSessionPayloadSchema, z.array(agentThreadRecordSchema)),
  'thread:get': readContract(wsThreadIdPayloadSchema, threadDetailSnapshotSchema),
  'thread:create': writeContract(wsThreadCreatePayloadSchema, agentThreadRecordSchema),
  'thread:update': writeContract(wsThreadUpdatePayloadSchema, agentThreadRecordSchema),
  'thread:delete': writeContract(wsThreadIdPayloadSchema, z.object({ deleted: z.boolean(), threadId: z.string() }).strict()),
  'thread:history': readContract(wsThreadHistoryPayloadSchema, threadHistoryPageSchema),
  'thread:fork': writeContract(wsThreadForkPayloadSchema, agentThreadRecordSchema),
  'thread:compact': writeContract(wsThreadCompactPayloadSchema, compactionRecordSchema.nullable()),
  'thread:context': readContract(wsThreadIdPayloadSchema, contextAssemblyReportSchema),
  'thread:subscribe': readContract(wsThreadIdPayloadSchema, wsThreadSubscriptionResponseSchema),
  'thread:unsubscribe': readContract(wsThreadIdPayloadSchema, z.object({ unsubscribed: z.boolean(), threadId: z.string() }).strict()),
  'thread:memory:get': readContract(wsThreadIdPayloadSchema, threadMemoryDocumentSchema),
  'thread:memory:update': writeContract(wsThreadMemoryUpdatePayloadSchema, threadMemoryDocumentSchema),
  'thread:memory:rebuild': writeContract(wsThreadMemoryRebuildPayloadSchema, threadMemoryDocumentSchema),
  'thread:trash:list': readContract(wsSessionPayloadSchema, z.array(wsThreadTrashEntrySchema)),
  'thread:trash:restore': writeContract(wsThreadIdPayloadSchema, agentThreadRecordSchema),
  'thread:trash:purge': writeContract(wsThreadIdPayloadSchema, z.object({ purged: z.boolean(), threadId: z.string() }).strict()),
  'run:list': readContract(wsRunListPayloadSchema, runSummaryPageSchema),
  'run:start': writeContract(wsRunStartPayloadSchema, analysisRunSchema),
  'run:get': readContract(wsRunIdPayloadSchema, runSnapshotSchema),
  'run:cancel': writeContract(wsRunIdPayloadSchema, analysisRunSchema),
  'run:resume': writeContract(wsRunIdPayloadSchema, analysisRunSchema),
  'run:steer': writeContract(wsRunSteerPayloadSchema, runSteeringRecordSchema),
  'run:respond-decision': writeContract(wsRespondDecisionPayloadSchema, analysisRunSchema),
  'run:subscribe': readContract(wsRunIdPayloadSchema, runSnapshotSchema),
  'run:unsubscribe': readContract(wsRunIdPayloadSchema, z.object({ unsubscribed: z.boolean(), runId: z.string() }).strict()),
  'tool:list': readContract(wsEmptyPayloadSchema, z.array(toolDescriptorSchema)),
  'tool:run': writeContract(wsToolRunPayloadSchema, directToolRunResponseSchema),
  'tool-catalog:list': readContract(wsEmptyPayloadSchema, z.array(wsUnknownRecordSchema)),
  'tool-catalog:upsert': writeContract(wsToolCatalogUpsertPayloadSchema, wsUnknownRecordSchema),
  'tool-catalog:delete': writeContract(wsToolCatalogDeletePayloadSchema, wsMutationAckSchema),
  'runtime-config:get': readContract(wsEmptyPayloadSchema, agentRuntimeConfigSchema),
  'runtime-config:update': writeContract(wsRuntimeConfigUpdatePayloadSchema, agentRuntimeConfigSchema),
  'provider:list': readContract(wsEmptyPayloadSchema, z.array(modelProviderDescriptorSchema)),
  'system:get': readContract(wsEmptyPayloadSchema, systemComponentsStatusSchema),
  'usage:summary': readContract(wsEmptyPayloadSchema, tokenUsageSummarySchema),
  'speech:authorization': writeContract(wsEmptyPayloadSchema, speechAuthorizationSchema),
  'memory:list': readContract(wsMemoryListPayloadSchema, wsMemoryListResponseSchema),
  'memory:read': readContract(wsMemoryReadDeletePayloadSchema, memoryFileRecordSchema),
  'memory:write': writeContract(wsMemoryWritePayloadSchema, memoryFileRecordSchema),
  'memory:delete': writeContract(wsMemoryReadDeletePayloadSchema, wsDeletedMemorySchema),
  'memory:search': readContract(wsMemorySearchPayloadSchema, wsMemorySearchResponseSchema),
  'memory:extract': writeContract(wsMemoryExtractPayloadSchema, wsMemoryListResponseSchema),
  'memory:dream': writeContract(wsMemoryDreamPayloadSchema, wsDreamMemoryResponseSchema),
  'memory:session:get': readContract(wsThreadIdPayloadSchema, threadMemoryDocumentSchema),
  'memory:session:rebuild': writeContract(wsThreadMemoryRebuildPayloadSchema, threadMemoryDocumentSchema),
  'memory:instructions:list': readContract(wsEmptyPayloadSchema, wsInstructionMemoryResponseSchema),
  'file:list': readContract(wsFileListPayloadSchema, wsFileListResponseSchema),
  'file:delete': writeContract(wsFileDeletePayloadSchema, z.object({ deleted: z.boolean(), id: z.string() }).strict()),
  'layer:list': readContract(wsLayerListPayloadSchema, z.array(layerDescriptorSchema)),
  'layer:update': writeContract(wsLayerUpdatePayloadSchema, layerDescriptorSchema),
  'layer:delete': writeContract(wsLayerDeletePayloadSchema, z.object({ deleted: z.boolean(), layerKey: z.string() }).strict()),
  'map-scene:update': writeContract(mapSceneUpdateSchema, mapSceneSchema),
  'automation:list': readContract(wsEmptyPayloadSchema, wsAutomationListResponseSchema),
  'automation:validate': readContract(wsAutomationDraftPayloadSchema, automationValidationResultSchema),
  'automation:create': writeContract(wsAutomationDraftPayloadSchema, automationDefinitionSchema),
  'automation:update': writeContract(wsAutomationUpdatePayloadSchema, automationDefinitionSchema),
  'automation:publish': writeContract(wsAutomationRevisionPayloadSchema, automationDefinitionSchema),
  'automation:disable': writeContract(wsAutomationIdPayloadSchema, automationDefinitionSchema),
  'automation:history': readContract(wsAutomationIdPayloadSchema, z.array(automationVersionRecordSchema)),
  'automation:start': writeContract(wsAutomationStartPayloadSchema, wsAutomationStartResponseSchema),
  'automation:cancel': writeContract(wsAutomationRunIdPayloadSchema, automationRunRecordSchema),
  'automation:run:get': readContract(wsAutomationRunIdPayloadSchema, automationRunRecordSchema),
  'automation:respond-approval': writeContract(wsAutomationApprovalPayloadSchema, wsAutomationApprovalResponseSchema),
  'scheduled-task:list': readContract(wsEmptyPayloadSchema, wsScheduledTaskListResponseSchema),
  'scheduled-task:create': writeContract(wsScheduledTaskCreatePayloadSchema, scheduledTaskSchema),
  'scheduled-task:update': writeContract(wsScheduledTaskUpdatePayloadSchema, scheduledTaskSchema),
  'scheduled-task:delete': writeContract(wsTaskIdPayloadSchema, scheduledTaskSchema),
  'background-task:list': readContract(wsEmptyPayloadSchema, wsBackgroundTaskListResponseSchema),
  'background-task:promote': readContract(wsTaskIdPayloadSchema, backgroundTaskInfoSchema),
  'background-task:cancel': writeContract(wsTaskIdPayloadSchema, backgroundTaskInfoSchema),
} satisfies Record<WsControlCommand, WsCommandContract>

export type WsCommandContractMap = typeof wsCommandContracts
export type WsCommandPayload<K extends WsControlCommand> = z.infer<WsCommandContractMap[K]['payload']>
export type WsCommandResponse<K extends WsControlCommand> = z.infer<WsCommandContractMap[K]['response']>

export function wsCommandContract<K extends WsControlCommand>(type: K): WsCommandContractMap[K] {
  return wsCommandContracts[type]
}

export interface WsControlRequest {
  type: WsControlCommand
  id: string
  payload: Record<string, unknown>
  meta?: {
    csrfToken?: string
  }
}

export type WsControlResponse<T = unknown> = {
  type: 'response'
  id: string | null
  payload: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
}

const wsPushEnvelope = <const TType extends string, TData extends z.ZodType>(
  type: TType,
  data: TData,
) => z.object({
  type: z.literal(type),
  id: z.null(),
  payload: z.object({ data }).strict(),
}).strict()

export const wsRunPushSchema = z.discriminatedUnion('type', [
  wsPushEnvelope('run.item', conversationItemSchema),
  wsPushEnvelope('run.event', runEventSchema),
  wsPushEnvelope('run.snapshot', z.object({
    run: analysisRunSchema,
    items: z.array(conversationItemSchema),
    events: z.array(runEventSchema),
  }).strict()),
  wsPushEnvelope('thread.entry', transcriptEntrySchema),
  wsPushEnvelope('thread.updated', z.object({
    thread: agentThreadRecordSchema,
    manifest: threadManifestSchema,
  }).strict()),
  wsPushEnvelope('thread.compacted', compactionRecordSchema),
  wsPushEnvelope('thread.memory.updated', threadMemoryDocumentSchema),
  wsPushEnvelope('map.scene.updated', mapSceneSchema),
])

export type WsRunPush = z.infer<typeof wsRunPushSchema>
