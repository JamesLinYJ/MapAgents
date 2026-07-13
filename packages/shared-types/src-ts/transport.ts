// GeoForge HTTP/WS 传输投影协议。
import { z } from 'zod'
import {
  conversationItemSchema,
  runEventSchema,
  type ConversationItem,
  type RunEvent,
} from './core.js'
import {
  threadManifestSchema,
  transcriptEntrySchema,
  type CompactionRecord,
  type ThreadManifest,
  type ThreadMemoryDocument,
  type TranscriptEntry,
} from './conversation.js'
import {
  analysisRunSchema,
  agentThreadRecordSchema,
  authMeSchema,
  runSummarySchema,
  sessionRecordSchema,
  type AgentThreadRecord,
  type AnalysisRun,
} from './platform.js'
import { modelProviderDescriptorSchema } from './resources.js'

export const runSummaryPageSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})

export const workspaceBootstrapSnapshotSchema = z.object({
  auth: authMeSchema,
  session: sessionRecordSchema,
  threads: z.array(agentThreadRecordSchema),
  providers: z.array(modelProviderDescriptorSchema),
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

export const publicShareThreadSchema = agentThreadRecordSchema.pick({
  id: true,
  title: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  latestUserQuery: true,
  latestAssistantSummary: true,
  historyPreview: true,
  runCount: true,
})

export const publicShareSnapshotSchema = z.object({
  shareId: z.string(),
  session: z.object({
    createdAt: z.string(),
    status: z.string(),
  }),
  threads: z.array(publicShareThreadSchema),
  selectedThread: publicShareThreadSchema.nullable(),
  history: z.object({
    entries: z.array(transcriptEntrySchema),
    nextCursor: z.string().nullable(),
  }).nullable(),
})

export type PublicShareThread = z.infer<typeof publicShareThreadSchema>
export type PublicShareSnapshot = z.infer<typeof publicShareSnapshotSchema>

// --- WebSocket control plane ---

export type WsControlCommand =
  | 'workspace:bootstrap'
  | 'session:get-default' | 'session:get'
  | 'thread:list' | 'thread:get' | 'thread:create' | 'thread:update' | 'thread:delete'
  | 'thread:history' | 'thread:fork' | 'thread:compact' | 'thread:context'
  | 'thread:subscribe' | 'thread:unsubscribe'
  | 'thread:memory:get' | 'thread:memory:update' | 'thread:memory:rebuild'
  | 'thread:trash:list' | 'thread:trash:restore' | 'thread:trash:purge'
  | 'run:list' | 'run:start' | 'run:get' | 'run:cancel' | 'run:resume' | 'run:steer' | 'run:respond-decision' | 'run:subscribe' | 'run:unsubscribe'
  | 'tool:list' | 'tool:run'
  | 'tool-catalog:list' | 'tool-catalog:upsert' | 'tool-catalog:delete'
  | 'runtime-config:get' | 'runtime-config:update'
  | 'provider:list' | 'system:get'
  | 'usage:summary'
  | 'speech:authorization'
  | 'memory:list' | 'memory:read' | 'memory:write' | 'memory:delete' | 'memory:search'
  | 'memory:extract' | 'memory:dream'
  | 'memory:session:get' | 'memory:session:rebuild'
  | 'memory:instructions:list'
  | 'file:list' | 'file:delete'
  | 'layer:list' | 'layer:update' | 'layer:delete'
  | 'workflow:list' | 'workflow:validate' | 'workflow:create' | 'workflow:update'
  | 'workflow:publish' | 'workflow:disable' | 'workflow:history'
  | 'workflow:start' | 'workflow:cancel' | 'workflow:run:get' | 'workflow:respond-approval'
  | 'scheduled-task:list' | 'scheduled-task:create' | 'scheduled-task:update' | 'scheduled-task:delete'
  | 'background-task:list' | 'background-task:promote' | 'background-task:cancel'

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

export type WsRunPush =
  | { type: 'run.item'; id: null; payload: { data: ConversationItem } }
  | { type: 'run.event'; id: null; payload: { data: RunEvent } }
  | { type: 'run.snapshot'; id: null; payload: { data: { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] } } }
  | { type: 'thread.entry'; id: null; payload: { data: TranscriptEntry } }
  | { type: 'thread.updated'; id: null; payload: { data: { thread: AgentThreadRecord; manifest: ThreadManifest } } }
  | { type: 'thread.compacted'; id: null; payload: { data: CompactionRecord } }
  | { type: 'thread.memory.updated'; id: null; payload: { data: ThreadMemoryDocument } }
