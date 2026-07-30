// GeoForge HTTP/WS 传输投影协议。
import { z } from 'zod'
import {
  conversationItemSchema,
  runEventSchema,
} from './core.js'
import {
  compactionRecordSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  transcriptEntrySchema,
} from './conversation.js'
import {
  analysisRunSchema,
  agentThreadRecordSchema,
  authMeSchema,
  runSummarySchema,
  sessionRecordSchema,
} from './platform.js'
import { mapSceneSchema } from './map.js'
import { modelProviderDescriptorSchema, toolDescriptorSchema } from './resources.js'

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
