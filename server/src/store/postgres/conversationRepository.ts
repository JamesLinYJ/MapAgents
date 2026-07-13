import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm'

import {
  agentThreadRecordSchema,
  analysisRunSchema,
  compactionRecordSchema,
  conversationItemSchema,
  runCheckpointSchema,
  runEventSchema,
  runSteeringRecordSchema,
  sessionRecordSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  toolValueRefSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type AnalysisRun,
  type CompactionRecord,
  type ConversationItem,
  type RunCheckpoint,
  type RunEvent,
  type RunSteeringRecord,
  type SessionRecord,
  type ThreadManifest,
  type ThreadMemoryDocument,
  type ToolValueRef,
  type TranscriptEntry,
  type TranscriptEntryKind,
} from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformEventOutbox,
  platformRunInputs,
  platformRunRecords,
  platformRuns,
  platformSessions,
  platformThreadCompactions,
  platformThreadMemoryVersions,
  platformThreads,
} from '../../db/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import { summarizeAssistantText } from '../../conversation/items.js'
import { makeId } from '../../utils/ids.js'
import { decodeCursor, encodeCursor, estimateTokens } from '../fileConversationIo.js'
import { RunMutationQueue } from '../runMutationQueue.js'
import { MemoryVersionConflictError } from '../storeErrors.js'

export interface ConversationSnapshot {
  sessions: SessionRecord[]
  threads: AgentThreadRecord[]
  deletedThreads: DeletedThreadRecord[]
  runs: AnalysisRun[]
}

export interface DeletedThreadRecord {
  thread: AgentThreadRecord
  manifest: ThreadManifest
  deletedAt: string
  purgeAfter: string
}

export interface ThreadMemoryVersionReference {
  threadId: string
  version: number
  contentHash: string
  source: ThreadMemoryDocument['source']
  basedOnEntryId: string | null
  estimatedTokens: number
  createdAt: string
}

export interface ThreadLifecycleResult {
  session: SessionRecord
  thread: AgentThreadRecord
  manifest: ThreadManifest
}

export interface RunLifecycleResult {
  session: SessionRecord
  thread: AgentThreadRecord | null
  run: AnalysisRun
}

export interface TrashThreadLifecycleResult {
  session: SessionRecord
  deleted: DeletedThreadRecord
}

export interface EnqueueRunInput {
  inputId: string
  entryId: string
  itemId: string
  runId: string
  content: string
}

export interface AppendConversationEntryInput {
  threadId: string
  runId?: string | null
  turnId?: string | null
  kind: TranscriptEntryKind
  payload?: Record<string, unknown>
  parentEntryId?: string | null
  logicalParentEntryId?: string | null
  entryId?: string
}

export interface ThreadHistoryPage {
  entries: TranscriptEntry[]
  nextCursor: string | null
}

export interface ConversationRepository {
  loadSnapshot(): Promise<ConversationSnapshot>
  saveSession(session: SessionRecord): Promise<void>
  createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult>
  saveThread(thread: AgentThreadRecord): Promise<void>
  trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult>
  listTrash(sessionId: string): Promise<DeletedThreadRecord[]>
  getTrashedThread(threadId: string): Promise<DeletedThreadRecord>
  restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult>
  purgeThread(threadId: string, sessionId: string): Promise<SessionRecord>
  createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult>
  saveRun(run: AnalysisRun): Promise<void>
  saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  listRunsForThread(threadId: string): Promise<AnalysisRun[]>
  saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>
  saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: 2
  }): Promise<void>
  appendConversationItem(item: ConversationItem): Promise<void>
  listConversationItems(runId: string): Promise<ConversationItem[]>
  appendRunEvent(event: RunEvent): Promise<void>
  listRunEvents(runId: string): Promise<RunEvent[]>
  appendToolValue(runId: string, value: ToolValueRef): Promise<void>
  listToolValues(runId: string): Promise<ToolValueRef[]>
  getThreadManifest(threadId: string): Promise<ThreadManifest>
  saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference>
  getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null>
  appendCompaction(record: CompactionRecord): Promise<void>
  listCompactions(threadId: string): Promise<CompactionRecord[]>
  listReferencedObjectHashes(): Promise<string[]>
  appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry>
  readThreadHistory(threadId: string, cursor?: string | null, limit?: number): Promise<ThreadHistoryPage>
  readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]>
  forkConversation(sourceThreadId: string, targetThreadId: string, sourceEntryId: string): Promise<Map<string, string>>
  enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord>
  consumeRunInputs(runId: string): Promise<RunSteeringRecord[]>
  listRunInputs(runId: string): Promise<RunSteeringRecord[]>
}

// PostgreSQL 是结构化会话事实源。Repository 只处理数据库语义；Agent 运行时、
// WS 推送和诊断导出通过更窄的 Service 组合这些原子操作。
export class PostgresConversationRepository implements ConversationRepository {
  private readonly runMutations = new RunMutationQueue()

  constructor(private readonly db: Database) {}

  async loadSnapshot(): Promise<ConversationSnapshot> {
    const [sessionRows, threadRows, runRows] = await Promise.all([
      this.db.select().from(platformSessions),
      this.db.select().from(platformThreads),
      this.db.select().from(platformRuns),
    ])
    const activeThreadRows = threadRows.filter(row => row.status !== 'deleted')
    const activeThreadIds = new Set(activeThreadRows.map(row => row.threadId))
    return {
      sessions: sessionRows.map(sessionRecord),
      threads: activeThreadRows.map(agentThreadRecord),
      deletedThreads: threadRows
        .filter(row => row.status === 'deleted')
        .map(deletedThreadRecord),
      runs: runRows
        .filter(row => row.threadId === null || activeThreadIds.has(row.threadId))
        .map(runRecord),
    }
  }

  async saveSession(session: SessionRecord): Promise<void> {
    const values = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      createdByUserId: session.createdByUserId,
      visibility: session.visibility,
      status: session.status,
      shareToken: session.shareToken,
      latestThreadId: session.latestThreadId,
      latestRunId: session.latestRunId,
      latestUploadedLayerKey: session.latestUploadedLayerKey,
      latestMeteorologicalDatasetId: session.latestMeteorologicalDatasetId,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(),
    }
    await this.db.insert(platformSessions).values(values).onConflictDoUpdate({
      target: platformSessions.sessionId,
      set: { ...values, sessionId: undefined },
    })
  }

  async createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    if (thread.status !== 'active') throw new Error('新线程状态必须是 active')
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, thread.sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session || session.status !== 'active') throw new Error(`会话 '${thread.sessionId}' 不存在或不可用`)
      assertThreadOwnerMatchesSession(thread, session)

      const insertedRows = await tx.insert(platformThreads)
        .values(threadPersistenceValues(thread))
        .returning()
      const inserted = insertedRows[0]
      if (!inserted) throw new Error(`线程 '${thread.id}' 创建失败`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: thread.id,
        updatedAt: new Date(thread.updatedAt),
      }).where(eq(platformSessions.sessionId, thread.sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${thread.sessionId}' 更新失败`)
      return {
        session: sessionRecord(updatedSession),
        thread: agentThreadRecord(inserted),
        manifest: threadManifest(inserted),
      }
    })
  }

  async saveThread(thread: AgentThreadRecord): Promise<void> {
    if (thread.status === 'deleted') {
      throw new Error('删除线程必须使用 trashThread，以保证回收站时间元数据完整')
    }
    const values = threadPersistenceValues(thread)
    const rows = await this.db.update(platformThreads).set({
      workspaceId: values.workspaceId,
      createdByUserId: values.createdByUserId,
      visibility: values.visibility,
      title: values.title,
      status: values.status,
      latestRunId: values.latestRunId,
      latestUserQuery: values.latestUserQuery,
      latestAssistantSummary: values.latestAssistantSummary,
      latestRunStatus: values.latestRunStatus,
      latestArtifactId: values.latestArtifactId,
      latestArtifactName: values.latestArtifactName,
      historyPreview: values.historyPreview,
      runCount: values.runCount,
      updatedAt: values.updatedAt,
    }).where(and(
      eq(platformThreads.threadId, thread.id),
      eq(platformThreads.sessionId, thread.sessionId),
      ne(platformThreads.status, 'deleted'),
    )).returning({ threadId: platformThreads.threadId })
    if (!rows[0]) throw new Error(`线程 '${thread.id}' 不存在`)
  }

  async trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, thread.sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${thread.sessionId}' 不存在`)
      const threadRows = await tx.select().from(platformThreads).where(and(
        eq(platformThreads.threadId, thread.id),
        eq(platformThreads.sessionId, thread.sessionId),
      )).for('update').limit(1)
      const current = threadRows[0]
      if (!current || current.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)

      let replacement: typeof platformThreads.$inferSelect | null = null
      if (replacementThreadId) {
        const replacementRows = await tx.select().from(platformThreads).where(and(
          eq(platformThreads.threadId, replacementThreadId),
          eq(platformThreads.sessionId, thread.sessionId),
          ne(platformThreads.status, 'deleted'),
        )).for('update').limit(1)
        replacement = replacementRows[0] ?? null
        if (!replacement) throw new Error(`替代线程 '${replacementThreadId}' 不存在或不属于当前会话`)
      }

      const deletedAt = new Date(thread.updatedAt)
      const deletedRows = await tx.update(platformThreads).set({
        status: 'deleted',
        deletedAt,
        purgeAfter: new Date(purgeAfter),
        updatedAt: deletedAt,
      }).where(eq(platformThreads.threadId, thread.id)).returning()
      const deleted = deletedRows[0]
      if (!deleted) throw new Error(`线程 '${thread.id}' 删除失败`)

      let latestRunBelongsToDeletedThread = false
      if (session.latestRunId) {
        const latestRunRows = await tx.select({ threadId: platformRuns.threadId }).from(platformRuns)
          .where(eq(platformRuns.runId, session.latestRunId)).limit(1)
        latestRunBelongsToDeletedThread = latestRunRows[0]?.threadId === thread.id
      }
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId === thread.id
          ? replacement?.threadId ?? null
          : session.latestThreadId,
        latestRunId: latestRunBelongsToDeletedThread
          ? replacement?.latestRunId ?? null
          : session.latestRunId,
        updatedAt: deletedAt,
      }).where(eq(platformSessions.sessionId, thread.sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${thread.sessionId}' 更新失败`)
      return {
        session: sessionRecord(updatedSession),
        deleted: deletedThreadRecord(deleted),
      }
    })
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    const rows = await this.db.select().from(platformThreads).where(and(
      eq(platformThreads.sessionId, sessionId),
      eq(platformThreads.status, 'deleted'),
    )).orderBy(desc(platformThreads.deletedAt))
    return rows.map(deletedThreadRecord)
  }

  async getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    const rows = await this.db.select().from(platformThreads).where(and(
      eq(platformThreads.threadId, threadId),
      eq(platformThreads.status, 'deleted'),
    )).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`回收站线程 '${threadId}' 不存在`)
    return deletedThreadRecord(row)
  }

  async restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
      const rows = await tx.update(platformThreads).set({
        status: 'active',
        deletedAt: null,
        purgeAfter: null,
        updatedAt: new Date(),
      }).where(and(
        eq(platformThreads.threadId, threadId),
        eq(platformThreads.sessionId, sessionId),
        eq(platformThreads.status, 'deleted'),
      )).returning()
      const row = rows[0]
      if (!row) throw new Error(`回收站线程 '${threadId}' 不存在`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId ?? threadId,
        latestRunId: session.latestRunId ?? row.latestRunId,
        updatedAt: new Date(),
      }).where(eq(platformSessions.sessionId, sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${sessionId}' 更新失败`)
      return {
        session: sessionRecord(updatedSession),
        thread: agentThreadRecord(row),
        manifest: threadManifest(row),
      }
    })
  }

  async purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
      const threadRows = await tx.select().from(platformThreads).where(and(
        eq(platformThreads.threadId, threadId),
        eq(platformThreads.sessionId, sessionId),
        eq(platformThreads.status, 'deleted'),
      )).for('update').limit(1)
      if (!threadRows[0]) throw new Error(`回收站线程 '${threadId}' 不存在`)
      let latestRunBelongsToThread = false
      if (session.latestRunId) {
        const latestRunRows = await tx.select({ threadId: platformRuns.threadId })
          .from(platformRuns)
          .where(and(
            eq(platformRuns.runId, session.latestRunId),
            eq(platformRuns.sessionId, sessionId),
          ))
          .limit(1)
        latestRunBelongsToThread = latestRunRows[0]?.threadId === threadId
      }
      const rows = await tx.delete(platformThreads)
        .where(eq(platformThreads.threadId, threadId))
        .returning({ threadId: platformThreads.threadId })
      if (!rows[0]) throw new Error(`回收站线程 '${threadId}' 清理失败`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId === threadId ? null : session.latestThreadId,
        latestRunId: latestRunBelongsToThread ? null : session.latestRunId,
        updatedAt: new Date(),
      }).where(eq(platformSessions.sessionId, sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${sessionId}' 更新失败`)
      return sessionRecord(updatedSession)
    })
  }

  async createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult> {
    if (run.status !== 'queued') throw new Error('新运行状态必须是 queued')
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, run.sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session || session.status !== 'active') throw new Error(`会话 '${run.sessionId}' 不存在或不可用`)

      let thread: typeof platformThreads.$inferSelect | null = null
      if (run.threadId) {
        const threadRows = await tx.select().from(platformThreads).where(and(
          eq(platformThreads.threadId, run.threadId),
          eq(platformThreads.sessionId, run.sessionId),
          ne(platformThreads.status, 'deleted'),
        )).for('update').limit(1)
        thread = threadRows[0] ?? null
        if (!thread) throw new Error(`线程 '${run.threadId}' 不存在或不属于当前会话`)
        assertRunOwnerMatchesThread(run, thread)
      } else {
        assertRunOwnerMatchesSession(run, session)
      }

      const insertedRows = await tx.insert(platformRuns).values(runPersistenceValues(run)).returning()
      const insertedRun = insertedRows[0]
      if (!insertedRun) throw new Error(`运行 '${run.id}' 创建失败`)

      let updatedThread: typeof platformThreads.$inferSelect | null = null
      if (thread) {
        const updatedThreadRows = await tx.update(platformThreads).set({
          latestRunId: run.id,
          latestUserQuery: run.userQuery,
          latestRunStatus: run.status,
          runCount: sql`${platformThreads.runCount} + 1`,
          updatedAt: new Date(run.updatedAt),
        }).where(eq(platformThreads.threadId, thread.threadId)).returning()
        updatedThread = updatedThreadRows[0] ?? null
        if (!updatedThread) throw new Error(`线程 '${thread.threadId}' 更新失败`)
      }

      const updatedSessionRows = await tx.update(platformSessions).set({
        latestRunId: run.id,
        latestThreadId: updatedThread?.threadId ?? session.latestThreadId,
        updatedAt: new Date(run.updatedAt),
      }).where(eq(platformSessions.sessionId, run.sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${run.sessionId}' 更新失败`)
      return {
        session: sessionRecord(updatedSession),
        thread: updatedThread ? agentThreadRecord(updatedThread) : null,
        run: runRecord(insertedRun),
      }
    })
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    const values = runPersistenceValues(run)
    await this.runMutations.run(run.id, async () => {
      const rows = await this.db.update(platformRuns).set(runUpdateValues(values))
        .where(eq(platformRuns.runId, run.id))
        .returning({ runId: platformRuns.runId })
      if (!rows[0]) throw new Error(`运行 '${run.id}' 不存在`)
    })
  }

  async saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const values = runPersistenceValues(run)
    const updates: Partial<typeof platformRuns.$inferInsert> = runUpdateValues(values)
    if (fields.activeEntryId !== undefined) updates.activeEntryId = fields.activeEntryId
    if (fields.pendingToolCallIds !== undefined) updates.pendingToolCallIds = fields.pendingToolCallIds
    if (fields.recoveryStatus !== undefined) updates.recoveryStatus = fields.recoveryStatus
    await this.runMutations.run(run.id, async () => {
      const rows = await this.db.update(platformRuns).set(updates)
        .where(eq(platformRuns.runId, run.id))
        .returning({ runId: platformRuns.runId })
      if (!rows[0]) throw new Error(`运行 '${run.id}' 不存在`)
    })
  }

  async listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    const rows = await this.db.select().from(platformRuns)
      .where(eq(platformRuns.threadId, threadId))
      .orderBy(asc(platformRuns.createdAt))
    return rows.map(runRecord)
  }

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const updates: Partial<typeof platformRuns.$inferInsert> = { updatedAt: new Date() }
    if (fields.activeEntryId !== undefined) updates.activeEntryId = fields.activeEntryId
    if (fields.pendingToolCallIds !== undefined) updates.pendingToolCallIds = fields.pendingToolCallIds
    if (fields.recoveryStatus !== undefined) updates.recoveryStatus = fields.recoveryStatus
    await this.runMutations.run(runId, async () => {
      const rows = await this.db.update(platformRuns).set(updates)
        .where(eq(platformRuns.runId, runId))
        .returning({ runId: platformRuns.runId })
      if (!rows[0]) throw new Error(`运行 '${runId}' 不存在`)
    })
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    const rows = await this.db.select().from(platformRuns)
      .where(eq(platformRuns.runId, runId)).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`运行 '${runId}' 不存在`)
    return runCheckpointSchema.parse({
      schemaVersion: 2,
      run: runRecord(row),
      activeEntryId: row.activeEntryId,
      pendingToolCallIds: row.pendingToolCallIds,
      lastPersistedAt: row.updatedAt.toISOString(),
      recoveryStatus: row.recoveryStatus,
      orchestrationEngine: row.orchestrationEngine,
      sdkStateContentHash: row.sdkStateContentHash,
      agentsSdkVersion: row.sdkVersion,
      runtimeConfigDigest: row.runtimeConfigDigest,
      sdkStateSchemaVersion: row.sdkStateSchemaVersion,
      sdkStateUpdatedAt: row.sdkStateUpdatedAt?.toISOString() ?? null,
    })
  }

  async saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: 2
  }): Promise<void> {
    await this.runMutations.run(runId, async () => {
      const updatedAt = new Date()
      const rows = await this.db.update(platformRuns).set({
        orchestrationEngine: 'openai_agents',
        sdkStateContentHash: input.contentHash,
        sdkVersion: input.agentsSdkVersion,
        runtimeConfigDigest: input.runtimeConfigDigest,
        sdkStateSchemaVersion: input.sdkStateSchemaVersion,
        sdkStateUpdatedAt: updatedAt,
        updatedAt,
      }).where(eq(platformRuns.runId, runId)).returning({ runId: platformRuns.runId })
      if (!rows[0]) throw new Error(`运行 '${runId}' 不存在`)
    })
  }

  async appendConversationItem(item: ConversationItem): Promise<void> {
    const parsed = conversationItemSchema.parse(item)
    const traceId = stringContextValue('traceId')
    await this.runMutations.run(parsed.runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({ threadId: platformRuns.threadId, status: platformRuns.status })
        .from(platformRuns)
        .where(eq(platformRuns.runId, parsed.runId))
        .for('update')
        .limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${parsed.runId}' 不存在`)
      if (parsed.threadId !== null && run.threadId !== parsed.threadId) {
        throw new Error(`运行记录的 threadId 与运行 '${parsed.runId}' 不一致`)
      }
      await this.appendRunRecords(tx, parsed.runId, run.threadId, [{ recordType: 'item', payloadJson: parsed }], traceId)

      if (run.threadId && parsed.itemType === 'message' && parsed.role === 'assistant') {
        const summary = summarizeAssistantText(parsed.body ?? '')
        if (summary) {
          await tx.update(platformThreads).set({ latestAssistantSummary: summary, updatedAt: new Date() })
            .where(eq(platformThreads.threadId, run.threadId))
        }
      } else if (run.threadId && parsed.itemType === 'result') {
        await tx.update(platformThreads).set({ latestRunStatus: run.status, updatedAt: new Date() })
          .where(eq(platformThreads.threadId, run.threadId))
      }
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: parsed.runId,
        eventType: 'run.item',
        payloadJson: parsed,
        traceId,
      })
    }))
  }

  async listConversationItems(runId: string): Promise<ConversationItem[]> {
    const rows = await this.db.select({ payloadJson: platformRunRecords.payloadJson })
      .from(platformRunRecords)
      .where(and(
        eq(platformRunRecords.runId, runId),
        eq(platformRunRecords.recordType, 'item'),
      ))
      .orderBy(asc(platformRunRecords.sequence))
    const latest = new Map<string, ConversationItem>()
    for (const row of rows) {
      const item = conversationItemSchema.parse(row.payloadJson)
      latest.set(item.itemId, item)
    }
    return [...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    const parsed = runEventSchema.parse(event)
    await this.appendTypedRunRecord(parsed.runId, parsed.threadId, 'event', parsed, 'run.event')
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.db.select({ payloadJson: platformRunRecords.payloadJson })
      .from(platformRunRecords)
      .where(and(
        eq(platformRunRecords.runId, runId),
        eq(platformRunRecords.recordType, 'event'),
      ))
      .orderBy(asc(platformRunRecords.sequence))
    return rows.map(row => runEventSchema.parse(row.payloadJson))
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    const parsed = toolValueRefSchema.parse(value)
    await this.appendTypedRunRecord(runId, null, 'value', parsed, 'run.value')
  }

  async listToolValues(runId: string): Promise<ToolValueRef[]> {
    const rows = await this.db.select({ payloadJson: platformRunRecords.payloadJson })
      .from(platformRunRecords)
      .where(and(
        eq(platformRunRecords.runId, runId),
        eq(platformRunRecords.recordType, 'value'),
      ))
      .orderBy(asc(platformRunRecords.sequence))
    return rows.map(row => toolValueRefSchema.parse(row.payloadJson))
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    const rows = await this.db.select().from(platformThreads)
      .where(eq(platformThreads.threadId, threadId)).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`线程 '${threadId}' 不存在`)
    return threadManifest(row)
  }

  async saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference> {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, input.threadId)).for('update').limit(1)
      const thread = rows[0]
      if (!thread || thread.status === 'deleted') throw new Error(`线程 '${input.threadId}' 不存在`)
      if (thread.memoryVersion !== input.expectedVersion) {
        throw new MemoryVersionConflictError(input.expectedVersion, thread.memoryVersion)
      }
      if (input.version !== thread.memoryVersion + 1) {
        throw new Error(`线程记忆版本必须从 ${thread.memoryVersion} 递增到 ${thread.memoryVersion + 1}`)
      }
      const createdAt = new Date(input.createdAt)
      await tx.insert(platformThreadMemoryVersions).values({
        threadId: input.threadId,
        version: input.version,
        contentHash: input.contentHash,
        source: input.source,
        basedOnEntryId: input.basedOnEntryId,
        estimatedTokens: input.estimatedTokens,
        createdAt,
      })
      await tx.update(platformThreads).set({
        memoryVersion: input.version,
        memoryBasedOnTokens: thread.estimatedContextTokens,
        updatedAt: createdAt,
      }).where(eq(platformThreads.threadId, input.threadId))
      return threadMemoryVersionReference({
        threadId: input.threadId,
        version: input.version,
        contentHash: input.contentHash,
        source: input.source,
        basedOnEntryId: input.basedOnEntryId,
        estimatedTokens: input.estimatedTokens,
        createdAt,
      })
    })
  }

  async getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    const threadRows = await this.db.select({ threadId: platformThreads.threadId })
      .from(platformThreads).where(and(
        eq(platformThreads.threadId, threadId),
        ne(platformThreads.status, 'deleted'),
      )).limit(1)
    if (!threadRows[0]) throw new Error(`线程 '${threadId}' 不存在`)
    const rows = await this.db.select().from(platformThreadMemoryVersions)
      .where(eq(platformThreadMemoryVersions.threadId, threadId))
      .orderBy(desc(platformThreadMemoryVersions.version)).limit(1)
    return rows[0] ? threadMemoryVersionReference(rows[0]) : null
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    const parsed = compactionRecordSchema.parse(record)
    await this.db.transaction(async tx => {
      const existingRows = await tx.select().from(platformThreadCompactions)
        .where(eq(platformThreadCompactions.compactionId, parsed.compactionId)).limit(1)
      const existing = existingRows[0]
      if (existing) {
        const current = compactionRecord(existing)
        if (JSON.stringify(current) !== JSON.stringify(parsed)) {
          throw new Error(`压缩记录 '${parsed.compactionId}' 与首次写入不一致`)
        }
        return
      }
      await tx.insert(platformThreadCompactions).values({
        compactionId: parsed.compactionId,
        threadId: parsed.threadId,
        boundaryEntryId: parsed.boundaryEntryId,
        summaryEntryId: parsed.summaryEntryId,
        firstCompactedEntryId: parsed.firstCompactedEntryId,
        lastCompactedEntryId: parsed.lastCompactedEntryId,
        preservedFromEntryId: parsed.preservedFromEntryId,
        summary: parsed.summary,
        strategy: parsed.strategy,
        preTokens: parsed.preTokens,
        postTokens: parsed.postTokens,
        createdAt: new Date(parsed.createdAt),
      })
      const updated = await tx.update(platformThreads).set({
        latestCompactionId: parsed.compactionId,
        estimatedContextTokens: parsed.postTokens,
        updatedAt: new Date(parsed.createdAt),
      }).where(eq(platformThreads.threadId, parsed.threadId)).returning({ threadId: platformThreads.threadId })
      if (!updated[0]) throw new Error(`线程 '${parsed.threadId}' 不存在`)
    })
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    const rows = await this.db.select().from(platformThreadCompactions)
      .where(eq(platformThreadCompactions.threadId, threadId))
      .orderBy(asc(platformThreadCompactions.createdAt))
    return rows.map(compactionRecord)
  }

  async listReferencedObjectHashes(): Promise<string[]> {
    const [runRows, memoryRows, entryRows, recordRows] = await Promise.all([
      this.db.select({ hash: platformRuns.sdkStateContentHash }).from(platformRuns),
      this.db.select({ hash: platformThreadMemoryVersions.contentHash }).from(platformThreadMemoryVersions),
      this.db.select({ payload: platformConversationEntries.payloadJson }).from(platformConversationEntries),
      this.db.select({ payload: platformRunRecords.payloadJson }).from(platformRunRecords),
    ])
    const hashes = new Set<string>()
    for (const row of [...runRows, ...memoryRows]) {
      if (row.hash && /^[a-f0-9]{64}$/u.test(row.hash)) hashes.add(row.hash)
    }
    for (const row of [...entryRows, ...recordRows]) collectSha256Strings(row.payload, hashes)
    return [...hashes]
  }

  async appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    const traceId = stringContextValue('traceId')
    const append = () => this.db.transaction(async tx => {
      const existingId = input.entryId
      if (existingId) {
        const existing = await tx.select().from(platformConversationEntries)
          .where(eq(platformConversationEntries.entryId, existingId)).limit(1)
        const row = existing[0]
        if (row) return transcriptEntry(row)
      }

      if (input.runId) {
        const runRows = await tx.select({ threadId: platformRuns.threadId }).from(platformRuns)
          .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
        const run = runRows[0]
        if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
        if (run.threadId !== input.threadId) {
          throw new Error(`运行 '${input.runId}' 不属于线程 '${input.threadId}'`)
        }
      }

      const threadRows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, input.threadId)).for('update').limit(1)
      const thread = threadRows[0]
      if (!thread) throw new Error(`线程 '${input.threadId}' 不存在`)
      if (thread.status === 'deleted') throw new Error(`线程 '${input.threadId}' 已删除`)
      if (thread.quarantined) throw new Error(`线程已隔离：${thread.quarantineReason ?? '存储损坏'}`)

      const entryId = input.entryId ?? makeId('entry')
      const parentEntryId = input.parentEntryId === undefined
        ? thread.activeLeafEntryId
        : input.parentEntryId
      await assertEntryBelongsToThread(tx, parentEntryId, input.threadId)
      await assertEntryBelongsToThread(tx, input.logicalParentEntryId ?? null, input.threadId)
      const createdAt = new Date()
      const payloadJson = input.payload ?? {}
      const sequence = thread.nextEntrySequence
      const row = {
        entryId,
        sessionId: thread.sessionId,
        threadId: input.threadId,
        runId: input.runId ?? null,
        turnId: input.turnId ?? null,
        sequence,
        parentEntryId,
        logicalParentEntryId: input.logicalParentEntryId ?? null,
        kind: input.kind,
        payloadJson,
        traceId,
        createdAt,
      }
      await tx.insert(platformConversationEntries).values(row)
      await tx.update(platformThreads).set({
        nextEntrySequence: sequence + 1,
        activeLeafEntryId: entryId,
        transcriptEntryCount: thread.transcriptEntryCount + 1,
        estimatedContextTokens: thread.estimatedContextTokens + estimateTokens(JSON.stringify(payloadJson)),
        updatedAt: createdAt,
      }).where(eq(platformThreads.threadId, input.threadId))
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'thread',
        aggregateId: input.threadId,
        eventType: 'thread.entry.appended',
        payloadJson: { entryId, runId: input.runId ?? null, kind: input.kind },
        traceId,
      })
      return transcriptEntry(row)
    })
    return input.runId ? this.runMutations.run(input.runId, append) : append()
  }

  async readThreadHistory(threadId: string, cursor?: string | null, limit = 100): Promise<ThreadHistoryPage> {
    const before = cursor ? decodeCursor(cursor) : null
    const pageSize = Math.min(200, Math.max(1, Math.trunc(limit)))
    const condition = before === null
      ? eq(platformConversationEntries.threadId, threadId)
      : and(
          eq(platformConversationEntries.threadId, threadId),
          lt(platformConversationEntries.sequence, before),
        )
    const rows = await this.db.select().from(platformConversationEntries)
      .where(condition)
      .orderBy(desc(platformConversationEntries.sequence))
      .limit(pageSize + 1)
    const hasMore = rows.length > pageSize
    const selected = hasMore ? rows.slice(0, pageSize) : rows
    const oldest = selected.at(-1)
    return {
      entries: selected.map(transcriptEntry).reverse(),
      nextCursor: hasMore && oldest ? encodeCursor(oldest.sequence) : null,
    }
  }

  async readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    const [threadRows, rows] = await Promise.all([
      this.db.select().from(platformThreads).where(eq(platformThreads.threadId, threadId)).limit(1),
      this.db.select().from(platformConversationEntries)
        .where(eq(platformConversationEntries.threadId, threadId))
        .orderBy(asc(platformConversationEntries.sequence)),
    ])
    const thread = threadRows[0]
    if (!thread) throw new Error(`线程 '${threadId}' 不存在`)
    const leafId = leafEntryId ?? thread.activeLeafEntryId
    if (!leafId) return []
    const byId = new Map(rows.map(row => [row.entryId, transcriptEntry(row)]))
    const chain: TranscriptEntry[] = []
    const seen = new Set<string>()
    let current = byId.get(leafId)
    if (!current) throw new Error(`线程 '${threadId}' 的活动叶子 '${leafId}' 不存在`)
    while (current) {
      if (seen.has(current.entryId)) throw new Error(`线程 '${threadId}' 的对话父链存在循环`)
      seen.add(current.entryId)
      chain.push(current)
      current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined
      if (chain.at(-1)?.parentEntryId && !current) {
        throw new Error(`线程 '${threadId}' 的对话父链引用了不存在的父条目`)
      }
    }
    return chain.reverse()
  }

  async forkConversation(
    sourceThreadId: string,
    targetThreadId: string,
    sourceEntryId: string,
  ): Promise<Map<string, string>> {
    const source = await this.readActiveConversation(sourceThreadId, sourceEntryId)
    return this.db.transaction(async tx => {
      const targetRows = await tx.select().from(platformThreads)
        .where(eq(platformThreads.threadId, targetThreadId)).for('update').limit(1)
      const target = targetRows[0]
      if (!target) throw new Error(`目标线程 '${targetThreadId}' 不存在`)
      if (target.transcriptEntryCount !== 0) throw new Error(`目标线程 '${targetThreadId}' 已包含对话记录`)

      const idMap = new Map<string, string>()
      const createdRows: Array<typeof platformConversationEntries.$inferInsert> = []
      for (const [index, entry] of source.entries()) {
        const entryId = makeId('entry')
        idMap.set(entry.entryId, entryId)
        createdRows.push({
          entryId,
          sessionId: target.sessionId,
          threadId: targetThreadId,
          runId: null,
          turnId: null,
          sequence: target.nextEntrySequence + index,
          parentEntryId: entry.parentEntryId ? idMap.get(entry.parentEntryId) ?? null : null,
          logicalParentEntryId: entry.logicalParentEntryId ? idMap.get(entry.logicalParentEntryId) ?? null : null,
          kind: entry.kind,
          payloadJson: { ...entry.payload, forkedFromEntryId: entry.entryId },
          traceId: stringContextValue('traceId'),
          createdAt: new Date(entry.timestamp),
        })
      }
      if (createdRows.length) await tx.insert(platformConversationEntries).values(createdRows)
      const activeLeafEntryId = createdRows.at(-1)?.entryId ?? null
      await tx.update(platformThreads).set({
        nextEntrySequence: target.nextEntrySequence + createdRows.length,
        activeLeafEntryId,
        transcriptEntryCount: createdRows.length,
        estimatedContextTokens: source.reduce(
          (total, entry) => total + estimateTokens(JSON.stringify(entry.payload)),
          0,
        ),
        forkedFromThreadId: sourceThreadId,
        forkedFromEntryId: sourceEntryId,
        updatedAt: new Date(),
      }).where(eq(platformThreads.threadId, targetThreadId))
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'thread',
        aggregateId: targetThreadId,
        eventType: 'thread.forked',
        payloadJson: { sourceThreadId, sourceEntryId, entryCount: createdRows.length },
        traceId: stringContextValue('traceId'),
      })
      return idMap
    })
  }

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    const normalized = input.content.trim()
    if (!normalized) throw new Error('引导消息不能为空')
    const traceId = stringContextValue('traceId')

    return this.runMutations.run(input.runId, () => this.db.transaction(async tx => {
      const existing = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.inputId, input.inputId)).limit(1)
      const existingRow = existing[0]
      if (existingRow) {
        if (existingRow.runId !== input.runId || existingRow.content !== normalized) {
          throw new Error(`引导消息 '${input.inputId}' 的幂等键已被其它内容使用`)
        }
        return steeringRecord(existingRow)
      }

      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
      if (run.status !== 'running') throw new Error(`运行 '${input.runId}' 已结束接收引导消息`)
      if (!run.threadId) throw new Error(`运行 '${input.runId}' 缺少 threadId`)

      const sequenceRows = await tx.update(platformThreads)
        .set({
          nextEntrySequence: sql`${platformThreads.nextEntrySequence} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(platformThreads.threadId, run.threadId))
        .returning({
          sessionId: platformThreads.sessionId,
          nextEntrySequence: platformThreads.nextEntrySequence,
          transcriptEntryCount: platformThreads.transcriptEntryCount,
          estimatedContextTokens: platformThreads.estimatedContextTokens,
        })
      const sequenceRow = sequenceRows[0]
      if (!sequenceRow) throw new Error(`运行 '${input.runId}' 所属线程不存在`)
      const sequence = sequenceRow.nextEntrySequence - 1

      const parentRows = await tx.select({ entryId: platformConversationEntries.entryId })
        .from(platformConversationEntries)
        .where(eq(platformConversationEntries.threadId, run.threadId))
        .orderBy(desc(platformConversationEntries.sequence))
        .limit(1)
      const parentEntryId = parentRows[0]?.entryId ?? null
      const queuedAt = new Date()
      await tx.insert(platformConversationEntries).values({
        entryId: input.entryId,
        sessionId: sequenceRow.sessionId,
        threadId: run.threadId,
        runId: run.runId,
        sequence,
        parentEntryId,
        logicalParentEntryId: null,
        kind: 'message',
        payloadJson: { role: 'user', content: normalized, steeringId: input.inputId },
        traceId,
        createdAt: queuedAt,
      })
      await tx.update(platformThreads).set({
        activeLeafEntryId: input.entryId,
        transcriptEntryCount: sequenceRow.transcriptEntryCount + 1,
        estimatedContextTokens: sequenceRow.estimatedContextTokens + estimateTokens(JSON.stringify({
          role: 'user', content: normalized, steeringId: input.inputId,
        })),
      }).where(eq(platformThreads.threadId, run.threadId))
      await tx.insert(platformRunInputs).values({
        inputId: input.inputId,
        runId: run.runId,
        threadId: run.threadId,
        entryId: input.entryId,
        itemId: input.itemId,
        kind: 'steering',
        content: normalized,
        status: 'queued',
        queuedAt,
      })
      await this.appendRunRecords(tx, run.runId, run.threadId, [{
        recordType: 'input.queued',
        payloadJson: {
          inputId: input.inputId,
          entryId: input.entryId,
          itemId: input.itemId,
          content: normalized,
        },
      }], traceId)
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: run.runId,
        eventType: 'run.input.queued',
        payloadJson: { inputId: input.inputId, entryId: input.entryId, itemId: input.itemId },
        traceId,
      })
      return runSteeringRecordSchema.parse({
        schemaVersion: 1,
        steeringId: input.inputId,
        entryId: input.entryId,
        itemId: input.itemId,
        runId: run.runId,
        threadId: run.threadId,
        content: normalized,
        status: 'queued',
        queuedAt: queuedAt.toISOString(),
        consumedAt: null,
      })
    }))
  }

  async consumeRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    const traceId = stringContextValue('traceId')
    return this.runMutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({ threadId: platformRuns.threadId }).from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)

      const rows = await tx.select().from(platformRunInputs)
        .where(and(eq(platformRunInputs.runId, runId), eq(platformRunInputs.status, 'queued')))
        .orderBy(asc(platformRunInputs.queuedAt))
        .for('update', { skipLocked: true })
      if (!rows.length) return []

      const consumedAt = new Date()
      for (const row of rows) {
        await tx.update(platformRunInputs)
          .set({ status: 'consumed', consumedAt })
          .where(and(
            eq(platformRunInputs.inputId, row.inputId),
            eq(platformRunInputs.status, 'queued'),
          ))
      }
      await this.appendRunRecords(tx, runId, run.threadId ?? rows[0]!.threadId, rows.map(row => ({
        recordType: 'input.consumed',
        payloadJson: { inputId: row.inputId, entryId: row.entryId, itemId: row.itemId },
      })), traceId)
      await tx.insert(platformEventOutbox).values(rows.map(row => ({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: runId,
        eventType: 'run.input.consumed',
        payloadJson: { inputId: row.inputId, entryId: row.entryId, itemId: row.itemId },
        traceId,
      })))
      return rows.map(row => steeringRecord({ ...row, status: 'consumed', consumedAt }))
    }))
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    const rows = await this.db.select().from(platformRunInputs)
      .where(eq(platformRunInputs.runId, runId))
      .orderBy(asc(platformRunInputs.queuedAt))
    return rows.map(steeringRecord)
  }

  private async appendRunRecords(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    runId: string,
    threadId: string | null,
    records: Array<{ recordType: string; payloadJson: Record<string, unknown> }>,
    traceId: string | null,
  ): Promise<void> {
    if (!records.length) return
    const sequenceRows = await tx.update(platformRuns)
      .set({ nextRecordSequence: sql`${platformRuns.nextRecordSequence} + ${records.length}` })
      .where(eq(platformRuns.runId, runId))
      .returning({ nextRecordSequence: platformRuns.nextRecordSequence })
    const sequenceRow = sequenceRows[0]
    if (!sequenceRow) throw new Error(`运行 '${runId}' 不存在`)
    const firstSequence = sequenceRow.nextRecordSequence - records.length
    await tx.insert(platformRunRecords).values(records.map((record, index) => ({
      recordId: makeId('record'),
      runId,
      threadId,
      sequence: firstSequence + index,
      recordType: record.recordType,
      payloadJson: record.payloadJson,
      traceId,
    })))
  }

  private async appendTypedRunRecord(
    runId: string,
    threadId: string | null,
    recordType: string,
    payloadJson: Record<string, unknown>,
    outboxEventType: string,
  ): Promise<void> {
    const traceId = stringContextValue('traceId')
    await this.runMutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({ threadId: platformRuns.threadId })
        .from(platformRuns)
        .where(eq(platformRuns.runId, runId))
        .for('update')
        .limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      if (threadId !== null && run.threadId !== threadId) {
        throw new Error(`运行记录的 threadId 与运行 '${runId}' 不一致`)
      }
      await this.appendRunRecords(tx, runId, run.threadId ?? threadId, [{ recordType, payloadJson }], traceId)
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: runId,
        eventType: outboxEventType,
        payloadJson,
        traceId,
      })
    }))
  }
}

function steeringRecord(row: {
  inputId: string
  entryId: string
  itemId: string
  runId: string
  threadId: string
  content: string
  status: string
  queuedAt: Date
  consumedAt: Date | null
}): RunSteeringRecord {
  return runSteeringRecordSchema.parse({
    schemaVersion: 1,
    steeringId: row.inputId,
    entryId: row.entryId,
    itemId: row.itemId,
    runId: row.runId,
    threadId: row.threadId,
    content: row.content,
    status: row.status,
    queuedAt: row.queuedAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
  })
}

function runRecord(row: typeof platformRuns.$inferSelect): AnalysisRun {
  return analysisRunSchema.parse({
    id: row.runId,
    sessionId: row.sessionId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    userQuery: row.userQuery,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: row.stateJson,
    runtimeConfigSnapshot: row.runtimeConfigJson,
    conversationPath: null,
  })
}

function sessionRecord(row: typeof platformSessions.$inferSelect): SessionRecord {
  return sessionRecordSchema.parse({
    id: row.sessionId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    shareToken: row.shareToken,
    latestThreadId: row.latestThreadId,
    latestRunId: row.latestRunId,
    latestUploadedLayerKey: row.latestUploadedLayerKey,
    latestMeteorologicalDatasetId: row.latestMeteorologicalDatasetId,
  })
}

function threadPersistenceValues(thread: AgentThreadRecord): typeof platformThreads.$inferInsert {
  return {
    threadId: thread.id,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    title: thread.title,
    status: thread.status,
    latestRunId: thread.latestRunId,
    latestUserQuery: thread.latestUserQuery,
    latestAssistantSummary: thread.latestAssistantSummary,
    latestRunStatus: thread.latestRunStatus,
    latestArtifactId: thread.latestArtifactId,
    latestArtifactName: thread.latestArtifactName,
    historyPreview: thread.historyPreview,
    runCount: thread.runCount,
    deletedAt: null,
    purgeAfter: null,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
  }
}

function runPersistenceValues(run: AnalysisRun): typeof platformRuns.$inferInsert {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    threadId: run.threadId,
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    stateJson: run.state,
    runtimeConfigJson: run.runtimeConfigSnapshot,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  }
}

function runUpdateValues(
  values: typeof platformRuns.$inferInsert,
): Partial<typeof platformRuns.$inferInsert> {
  return {
    sessionId: values.sessionId,
    threadId: values.threadId,
    workspaceId: values.workspaceId,
    createdByUserId: values.createdByUserId,
    visibility: values.visibility,
    userQuery: values.userQuery,
    modelProvider: values.modelProvider,
    modelName: values.modelName,
    status: values.status,
    stateJson: values.stateJson,
    runtimeConfigJson: values.runtimeConfigJson,
    updatedAt: values.updatedAt,
  }
}

function assertThreadOwnerMatchesSession(
  thread: AgentThreadRecord,
  session: typeof platformSessions.$inferSelect,
): void {
  if (
    thread.workspaceId !== session.workspaceId
    || thread.createdByUserId !== session.createdByUserId
    || thread.visibility !== session.visibility
  ) {
    throw new Error(`线程 '${thread.id}' 的资源归属与会话 '${session.sessionId}' 不一致`)
  }
}

function assertRunOwnerMatchesThread(
  run: AnalysisRun,
  thread: typeof platformThreads.$inferSelect,
): void {
  if (
    run.workspaceId !== thread.workspaceId
    || run.createdByUserId !== thread.createdByUserId
    || run.visibility !== thread.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与线程 '${thread.threadId}' 不一致`)
  }
}

function assertRunOwnerMatchesSession(
  run: AnalysisRun,
  session: typeof platformSessions.$inferSelect,
): void {
  if (
    run.workspaceId !== session.workspaceId
    || run.createdByUserId !== session.createdByUserId
    || run.visibility !== session.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与会话 '${session.sessionId}' 不一致`)
  }
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}

function transcriptEntry(row: {
  entryId: string
  sequence: number
  parentEntryId: string | null
  logicalParentEntryId: string | null
  threadId: string
  runId: string | null
  turnId: string | null
  kind: string
  payloadJson: Record<string, unknown>
  createdAt: Date
}): TranscriptEntry {
  return transcriptEntrySchema.parse({
    schemaVersion: 2,
    seq: row.sequence,
    entryId: row.entryId,
    parentEntryId: row.parentEntryId,
    logicalParentEntryId: row.logicalParentEntryId,
    threadId: row.threadId,
    runId: row.runId,
    turnId: row.turnId,
    kind: row.kind,
    timestamp: row.createdAt.toISOString(),
    payload: row.payloadJson,
  })
}

function threadManifest(row: {
  threadId: string
  sessionId: string
  activeLeafEntryId: string | null
  nextEntrySequence: number
  transcriptEntryCount: number
  estimatedContextTokens: number
  latestCompactionId: string | null
  memoryVersion: number
  memoryBasedOnTokens: number
  forkedFromThreadId: string | null
  forkedFromEntryId: string | null
  quarantined: boolean
  quarantineReason: string | null
  createdAt: Date
  updatedAt: Date
}): ThreadManifest {
  return threadManifestSchema.parse({
    schemaVersion: 2,
    threadId: row.threadId,
    sessionId: row.sessionId,
    activeLeafEntryId: row.activeLeafEntryId,
    lastSequence: row.nextEntrySequence - 1,
    transcriptEntryCount: row.transcriptEntryCount,
    estimatedContextTokens: row.estimatedContextTokens,
    latestCompactionId: row.latestCompactionId,
    memoryVersion: row.memoryVersion,
    memoryBasedOnTokens: row.memoryBasedOnTokens,
    forkedFrom: row.forkedFromThreadId && row.forkedFromEntryId
      ? { threadId: row.forkedFromThreadId, entryId: row.forkedFromEntryId }
      : null,
    quarantined: row.quarantined,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function agentThreadRecord(row: typeof platformThreads.$inferSelect): AgentThreadRecord {
  return agentThreadRecordSchema.parse({
    id: row.threadId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestRunId: row.latestRunId,
    latestUserQuery: row.latestUserQuery,
    latestAssistantSummary: row.latestAssistantSummary,
    latestRunStatus: row.latestRunStatus,
    latestArtifactId: row.latestArtifactId,
    latestArtifactName: row.latestArtifactName,
    historyPreview: row.historyPreview,
    runCount: row.runCount,
    conversationPath: null,
  })
}

function deletedThreadRecord(row: typeof platformThreads.$inferSelect): DeletedThreadRecord {
  if (!row.deletedAt || !row.purgeAfter) {
    throw new Error(`已删除线程 '${row.threadId}' 缺少回收站时间信息`)
  }
  return {
    thread: agentThreadRecord(row),
    manifest: threadManifest(row),
    deletedAt: row.deletedAt.toISOString(),
    purgeAfter: row.purgeAfter.toISOString(),
  }
}

function threadMemoryVersionReference(
  row: typeof platformThreadMemoryVersions.$inferSelect,
): ThreadMemoryVersionReference {
  const source = threadMemoryDocumentSchema.shape.source.parse(row.source)
  return {
    threadId: row.threadId,
    version: row.version,
    contentHash: row.contentHash,
    source,
    basedOnEntryId: row.basedOnEntryId,
    estimatedTokens: row.estimatedTokens,
    createdAt: row.createdAt.toISOString(),
  }
}

function compactionRecord(row: typeof platformThreadCompactions.$inferSelect): CompactionRecord {
  return compactionRecordSchema.parse({
    schemaVersion: 2,
    compactionId: row.compactionId,
    threadId: row.threadId,
    boundaryEntryId: row.boundaryEntryId,
    summaryEntryId: row.summaryEntryId,
    firstCompactedEntryId: row.firstCompactedEntryId,
    lastCompactedEntryId: row.lastCompactedEntryId,
    preservedFromEntryId: row.preservedFromEntryId,
    summary: row.summary,
    strategy: row.strategy,
    preTokens: row.preTokens,
    postTokens: row.postTokens,
    createdAt: row.createdAt.toISOString(),
  })
}

function collectSha256Strings(value: unknown, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/u.test(value)) hashes.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSha256Strings(item, hashes)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) collectSha256Strings(item, hashes)
}

async function assertEntryBelongsToThread(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  entryId: string | null,
  threadId: string,
): Promise<void> {
  if (!entryId) return
  const rows = await tx.select({ threadId: platformConversationEntries.threadId })
    .from(platformConversationEntries)
    .where(eq(platformConversationEntries.entryId, entryId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error(`父对话条目 '${entryId}' 不存在`)
  if (row.threadId !== threadId) throw new Error(`父对话条目 '${entryId}' 不属于线程 '${threadId}'`)
}
