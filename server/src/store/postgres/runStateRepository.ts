// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运行状态持久化
//
//   文件:       runStateRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
//   来源:       runRepository.ts 的 Run 生命周期与状态事务边界
// --------------------------------------------------------------------------

import { and, asc, eq, ne, sql } from 'drizzle-orm'

import type { AnalysisRun, RunCheckpoint } from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import { platformRuns, platformSessions, platformThreads } from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { RunLifecycleResult, RunStateRepository } from './conversationPersistencePorts.js'
import {
  assertRunOwnerMatchesSession,
  assertRunOwnerMatchesThread,
  mapAnalysisRunRow,
  mapSessionRow,
  mapThreadRow,
  toRunInsertValues,
  toRunUpdateValues,
} from './conversationRowMappers.js'

/** Run 状态事实及创建时 Session/Thread 指针更新的事务边界。 */
export class PostgresRunStateRepository implements RunStateRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
  ) {}

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

      const insertedRows = await tx.insert(platformRuns).values(toRunInsertValues(run)).returning()
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
        session: mapSessionRow(updatedSession),
        thread: updatedThread ? mapThreadRow(updatedThread) : null,
        run: mapAnalysisRunRow(insertedRun),
      }
    })
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    const values = toRunInsertValues(run)
    await this.runMutations.run(run.id, async () => {
      const rows = await this.db.update(platformRuns).set(toRunUpdateValues(values))
        .where(eq(platformRuns.runId, run.id))
        .returning({ runId: platformRuns.runId })
      if (!rows[0]) throw new Error(`运行 '${run.id}' 不存在`)
    })
  }

  async saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const values = toRunInsertValues(run)
    const updates: Partial<typeof platformRuns.$inferInsert> = toRunUpdateValues(values)
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
    return rows.map(mapAnalysisRunRow)
  }
}
