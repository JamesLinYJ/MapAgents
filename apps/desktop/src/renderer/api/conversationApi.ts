// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话与线程 API
//
//   文件:       conversationApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  agentThreadRecordSchema,
  compactionRecordSchema,
  contextAssemblyReportSchema,
  runSummaryPageSchema,
  sessionRecordSchema,
  threadDetailSnapshotSchema,
  threadHistoryPageSchema,
  threadMemoryDocumentSchema,
  type AgentThreadRecord,
  type CompactionRecord,
  type ContextAssemblyReport,
  type RunSummaryPage,
  type SessionRecord,
  type ThreadDetailSnapshot,
  type ThreadHistoryPage,
  type ThreadMemoryDocument,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import {
  desktopWorkspaceBootstrapSnapshotSchema,
  type DesktopWorkspaceBootstrapSnapshot,
} from '../../contracts/desktopIpc'
import { requestControl } from './transport'

const deletedThreadSchema = z.object({ deleted: z.boolean(), threadId: z.string() })
const trashedThreadEntrySchema = z.object({
  thread: agentThreadRecordSchema,
  deletedAt: z.string(),
  purgeAfter: z.string(),
})
const purgedThreadSchema = z.object({ purged: z.boolean(), threadId: z.string() })

export function createSession(): Promise<SessionRecord> {
  return requestControl('session:get-default', {}, sessionRecordSchema)
}

export function bootstrapWorkspace(
  sessionId?: string,
  workspaceId?: string,
): Promise<DesktopWorkspaceBootstrapSnapshot> {
  return requestControl(
    'workspace:bootstrap',
    { sessionId, workspaceId },
    desktopWorkspaceBootstrapSnapshotSchema,
  )
}

export function getDefaultSession(): Promise<SessionRecord> {
  return requestControl('session:get-default', {}, sessionRecordSchema)
}

export function getSession(sessionId: string): Promise<SessionRecord> {
  return requestControl('session:get', { sessionId }, sessionRecordSchema)
}

export function listSessionThreads(sessionId: string): Promise<AgentThreadRecord[]> {
  return requestControl('thread:list', { sessionId }, z.array(agentThreadRecordSchema))
}

export function createThread(sessionId: string, title?: string): Promise<AgentThreadRecord> {
  return requestControl('thread:create', { sessionId, title }, agentThreadRecordSchema)
}

export function getThread(threadId: string): Promise<ThreadDetailSnapshot> {
  return requestControl('thread:get', { threadId }, threadDetailSnapshotSchema)
}

export function updateThread(threadId: string, title: string): Promise<AgentThreadRecord> {
  return requestControl('thread:update', { threadId, title }, agentThreadRecordSchema)
}

export function deleteThread(threadId: string): Promise<z.infer<typeof deletedThreadSchema>> {
  return requestControl('thread:delete', { threadId }, deletedThreadSchema)
}

export function listRunSummaries(
  sessionId: string,
  options: { threadId?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<RunSummaryPage> {
  return requestControl('run:list', { sessionId, ...options }, runSummaryPageSchema)
}

export function getThreadHistory(
  threadId: string,
  cursor?: string | null,
  limit = 100,
): Promise<ThreadHistoryPage> {
  return requestControl('thread:history', { threadId, cursor, limit }, threadHistoryPageSchema)
}

export function forkThread(threadId: string, entryId: string, title?: string): Promise<AgentThreadRecord> {
  return requestControl('thread:fork', { threadId, entryId, title }, agentThreadRecordSchema)
}

export function compactThread(threadId: string): Promise<CompactionRecord | null> {
  return requestControl('thread:compact', { threadId }, compactionRecordSchema.nullable())
}

export function getThreadContext(threadId: string): Promise<ContextAssemblyReport> {
  return requestControl('thread:context', { threadId }, contextAssemblyReportSchema)
}

export function getThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:get', { threadId }, threadMemoryDocumentSchema)
}

export function updateThreadMemory(
  threadId: string,
  content: string,
  expectedVersion: number,
): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:update', { threadId, content, expectedVersion }, threadMemoryDocumentSchema)
}

export function rebuildThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:rebuild', { threadId }, threadMemoryDocumentSchema)
}

export function listTrashedThreads(sessionId: string): Promise<Array<z.infer<typeof trashedThreadEntrySchema>>> {
  return requestControl('thread:trash:list', { sessionId }, z.array(trashedThreadEntrySchema))
}

export function restoreThread(threadId: string): Promise<AgentThreadRecord> {
  return requestControl('thread:trash:restore', { threadId }, agentThreadRecordSchema)
}

export function purgeThread(threadId: string): Promise<z.infer<typeof purgedThreadSchema>> {
  return requestControl('thread:trash:purge', { threadId }, purgedThreadSchema)
}
