// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态持久化
//
//   文件:       runStateRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       runRepository.ts 的 Run 生命周期与状态事务边界
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, ne, sql } from 'drizzle-orm'

import type { AnalysisRun, RunCheckpoint } from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import {
  platformRootRunBudgets,
  platformRuns,
  platformSessions,
  platformThreads,
} from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { DatabaseTransaction } from './runRecordAppender.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  buildRunCreatedEvents,
  buildRunTransitionEvents,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
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
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

/** Run 状态事实及创建时 Session/Thread 指针更新的事务边界。 */
export class PostgresRunStateRepository implements RunStateRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
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

      const rootBudget = run.runKind === 'child'
        ? await this.requireSpawnCapacity(tx, run)
        : null

      const insertedRows = await tx.insert(platformRuns).values(toRunInsertValues(run)).returning()
      const insertedRun = insertedRows[0]
      if (!insertedRun) throw new Error(`运行 '${run.id}' 创建失败`)
      const persistedRun = mapAnalysisRunRow(insertedRun)
      if (persistedRun.runKind === 'root') {
        await tx.insert(platformRootRunBudgets).values({ rootRunId: persistedRun.id })
      } else if (rootBudget) {
        const reserved = await tx.update(platformRootRunBudgets).set({
          totalChildren: rootBudget.totalChildren + 1,
          activeChildren: rootBudget.activeChildren + 1,
          version: rootBudget.version + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(platformRootRunBudgets.rootRunId, persistedRun.rootRunId!),
          eq(platformRootRunBudgets.version, rootBudget.version),
        )).returning()
        if (!reserved[0]) throw new Error(`根运行 '${persistedRun.rootRunId}' 的 child 预算预留冲突`)
      }
      const checkpoint = toRunDomainCheckpoint(insertedRun)
      const domainSnapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: run.id,
        expectedSequence: 0,
        events: buildRunCreatedEvents(persistedRun, checkpoint, 0),
      })
      assertRunDomainProjection(domainSnapshot, persistedRun)
      assertRunDomainCheckpointProjection(domainSnapshot, checkpoint)

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
        run: persistedRun,
      }
    })
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    const values = toRunInsertValues(run)
    await this.runMutations.run(run.id, async () => {
      await this.db.transaction(async tx => {
        const beforeRows = await tx.select().from(platformRuns)
          .where(eq(platformRuns.runId, run.id)).for('update').limit(1)
        const beforeRow = beforeRows[0]
        if (!beforeRow) throw new Error(`运行 '${run.id}' 不存在`)
        if (run.usedModelTokens !== beforeRow.usedModelTokens) {
          throw new Error(`运行 '${run.id}' 的模型词元只能通过用量事务推进`)
        }
        const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, run.id)
        const rows = await tx.update(platformRuns).set(toRunUpdateValues(values))
          .where(eq(platformRuns.runId, run.id))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${run.id}' 不存在`)
        await this.adjustActiveChildBudget(tx, beforeRow, afterRow)
        const persistedRun = mapAnalysisRunRow(afterRow)
        const events = buildRunTransitionEvents({
          before: mapAnalysisRunRow(beforeRow),
          after: persistedRun,
          expectedSequence: currentSnapshot.sequence,
          reason: 'run_state_saved',
        })
        const snapshot = events.length
          ? await this.domainJournal.appendInTransaction(tx, {
            runId: run.id,
            expectedSequence: currentSnapshot.sequence,
            events,
          })
          : currentSnapshot
        assertRunDomainProjection(snapshot, persistedRun)
        assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(afterRow))
      })
    })
  }

  /**
   * 模型用量、Run 投影与根预算必须在同一事务内推进。若先单独更新预算，
   * 后续普通 saveRun 会把内存中的旧 usedModelTokens 写回数据库。
   */
  async saveRunWithModelUsage(run: AnalysisRun, modelTokens: number): Promise<void> {
    if (!Number.isInteger(modelTokens) || modelTokens <= 0) {
      throw new Error('模型词元增量必须是正整数')
    }
    const values = toRunInsertValues(run)
    await this.runMutations.run(run.id, async () => {
      await this.db.transaction(async tx => {
        const beforeRows = await tx.select().from(platformRuns)
          .where(eq(platformRuns.runId, run.id)).for('update').limit(1)
        const beforeRow = beforeRows[0]
        if (!beforeRow) throw new Error(`运行 '${run.id}' 不存在`)
        if (run.status !== beforeRow.status) {
          throw new Error(`运行 '${run.id}' 的模型用量事务不能同时改变运行状态`)
        }
        if (run.usedModelTokens !== beforeRow.usedModelTokens + modelTokens) {
          throw new Error(`运行 '${run.id}' 的模型词元累计值与增量不一致`)
        }
        if (run.maxModelTokens !== null && run.usedModelTokens > run.maxModelTokens) {
          throw new Error(`运行 '${run.id}' 的模型词元预算已耗尽`)
        }
        if (run.maxWallClockMs !== null
          && Date.now() - new Date(run.createdAt).getTime() >= run.maxWallClockMs) {
          throw new Error(`运行 '${run.id}' 的 wall-clock 预算已耗尽`)
        }

        const budgetRows = await tx.select().from(platformRootRunBudgets)
          .where(eq(platformRootRunBudgets.rootRunId, beforeRow.rootRunId)).for('update').limit(1)
        const budget = budgetRows[0]
        if (!budget) throw new Error(`根运行 '${beforeRow.rootRunId}' 缺少根预算`)
        const rootUsedModelTokens = budget.usedModelTokens + modelTokens
        if (budget.maxTotalModelTokens !== null && rootUsedModelTokens > budget.maxTotalModelTokens) {
          throw new Error(`根运行 '${beforeRow.rootRunId}' 的模型词元预算已耗尽`)
        }
        if (budget.maxWallClockMs !== null
          && Date.now() - budget.startedAt.getTime() >= budget.maxWallClockMs) {
          throw new Error(`根运行 '${beforeRow.rootRunId}' 的 wall-clock 预算已耗尽`)
        }

        const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, run.id)
        const rows = await tx.update(platformRuns).set({
          ...toRunUpdateValues(values),
          usedModelTokens: run.usedModelTokens,
        })
          .where(eq(platformRuns.runId, run.id))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${run.id}' 不存在`)
        const updatedBudget = await tx.update(platformRootRunBudgets).set({
          usedModelTokens: rootUsedModelTokens,
          version: budget.version + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(platformRootRunBudgets.rootRunId, beforeRow.rootRunId),
          eq(platformRootRunBudgets.version, budget.version),
        )).returning()
        if (!updatedBudget[0]) throw new Error(`根运行 '${beforeRow.rootRunId}' 的词元预算 CAS 冲突`)

        const persistedRun = mapAnalysisRunRow(afterRow)
        const events = buildRunTransitionEvents({
          before: mapAnalysisRunRow(beforeRow),
          after: persistedRun,
          expectedSequence: currentSnapshot.sequence,
          reason: 'model_usage_recorded',
        })
        const snapshot = events.length
          ? await this.domainJournal.appendInTransaction(tx, {
            runId: run.id,
            expectedSequence: currentSnapshot.sequence,
            events,
          })
          : currentSnapshot
        assertRunDomainProjection(snapshot, persistedRun)
        assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(afterRow))
      })
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
      await this.db.transaction(async tx => {
        const beforeRows = await tx.select().from(platformRuns)
          .where(eq(platformRuns.runId, run.id)).for('update').limit(1)
        const beforeRow = beforeRows[0]
        if (!beforeRow) throw new Error(`运行 '${run.id}' 不存在`)
        const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, run.id)
        const rows = await tx.update(platformRuns).set(updates)
          .where(eq(platformRuns.runId, run.id))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${run.id}' 不存在`)
        await this.adjustActiveChildBudget(tx, beforeRow, afterRow)
        const persistedRun = mapAnalysisRunRow(afterRow)
        const checkpoint = toRunDomainCheckpoint(afterRow)
        const events = buildRunTransitionEvents({
          before: mapAnalysisRunRow(beforeRow),
          after: persistedRun,
          expectedSequence: currentSnapshot.sequence,
          reason: 'run_state_and_checkpoint_saved',
        })
        if (!isDeepStrictEqual(currentSnapshot.checkpoint, checkpoint)) {
          events.push(buildCheckpointChangedEvent({
            run: persistedRun,
            expectedSequence: currentSnapshot.sequence + events.length,
            checkpoint,
          }))
        }
        const snapshot = events.length
          ? await this.domainJournal.appendInTransaction(tx, {
            runId: run.id,
            expectedSequence: currentSnapshot.sequence,
            events,
          })
          : currentSnapshot
        assertRunDomainProjection(snapshot, persistedRun)
        assertRunDomainCheckpointProjection(snapshot, checkpoint)
      })
    })
  }

  async listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    const rows = await this.db.select().from(platformRuns)
      .where(eq(platformRuns.threadId, threadId))
      .orderBy(asc(platformRuns.createdAt))
    return rows.map(mapAnalysisRunRow)
  }

  private async requireSpawnCapacity(
    tx: DatabaseTransaction,
    child: AnalysisRun,
  ): Promise<typeof platformRootRunBudgets.$inferSelect> {
    if (!child.parentRunId || !child.rootRunId) throw new Error('child Run 缺少父/根身份')
    const parentRows = await tx.select().from(platformRuns)
      .where(eq(platformRuns.runId, child.parentRunId)).for('update').limit(1)
    const parent = parentRows[0]
    if (!parent) throw new Error(`父运行 '${child.parentRunId}' 不存在`)
    if (parent.rootRunId !== child.rootRunId) throw new Error('child Run 与父运行不属于同一根运行')
    if (parent.sessionId !== child.sessionId || parent.workspaceId !== child.workspaceId) {
      throw new Error('child Run 与父运行资源归属不一致')
    }
    if (child.spawnDepth !== parent.spawnDepth + 1) throw new Error('child Run 深度不是父运行深度加一')
    if (!child.agentPath.startsWith(`${parent.agentPath}/`)) throw new Error('child Run agentPath 不属于父路径')
    if (!isBudgetActiveStatus(parent.status)) throw new Error(`父运行 '${parent.runId}' 当前不能生成 child Run`)

    const budgetRows = await tx.select().from(platformRootRunBudgets)
      .where(eq(platformRootRunBudgets.rootRunId, child.rootRunId)).for('update').limit(1)
    const budget = budgetRows[0]
    if (!budget) throw new Error(`根运行 '${child.rootRunId}' 缺少根预算`)
    if (child.spawnDepth > budget.maxSpawnDepth) throw new Error('child Run 超过根运行最大生成深度')
    if (budget.totalChildren >= budget.maxTotalChildren) throw new Error('根运行累计 child 数预算已耗尽')
    if (budget.activeChildren >= budget.maxConcurrentChildren) throw new Error('根运行并发 child 数预算已耗尽')
    if (budget.maxTotalModelTokens !== null && budget.usedModelTokens >= budget.maxTotalModelTokens) {
      throw new Error('根运行模型词元预算已耗尽')
    }
    if (budget.maxWallClockMs !== null
      && Date.now() - budget.startedAt.getTime() >= budget.maxWallClockMs) {
      throw new Error('根运行 wall-clock 预算已耗尽')
    }
    const remainingTokens = budget.maxTotalModelTokens === null
      ? null
      : budget.maxTotalModelTokens - budget.usedModelTokens
    if (child.maxModelTokens !== null && remainingTokens !== null && child.maxModelTokens > remainingTokens) {
      throw new Error('child Run 模型词元预算超过根运行剩余额度')
    }
    return budget
  }

  private async adjustActiveChildBudget(
    tx: DatabaseTransaction,
    before: typeof platformRuns.$inferSelect,
    after: typeof platformRuns.$inferSelect,
  ): Promise<void> {
    if (before.runKind !== 'child' || after.runKind !== 'child') return
    const beforeActive = isBudgetActiveStatus(before.status)
    const afterActive = isBudgetActiveStatus(after.status)
    if (beforeActive === afterActive) return
    const rows = await tx.select().from(platformRootRunBudgets)
      .where(eq(platformRootRunBudgets.rootRunId, after.rootRunId)).for('update').limit(1)
    const budget = rows[0]
    if (!budget) throw new Error(`根运行 '${after.rootRunId}' 缺少根预算`)
    const delta = afterActive ? 1 : -1
    const activeChildren = budget.activeChildren + delta
    if (activeChildren < 0) throw new Error(`根运行 '${after.rootRunId}' 的活动 child 计数下溢`)
    if (activeChildren > budget.maxConcurrentChildren) throw new Error('根运行并发 child 数预算已耗尽')
    const updated = await tx.update(platformRootRunBudgets).set({
      activeChildren,
      version: budget.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(platformRootRunBudgets.rootRunId, after.rootRunId),
      eq(platformRootRunBudgets.version, budget.version),
    )).returning()
    if (!updated[0]) throw new Error(`根运行 '${after.rootRunId}' 的活动 child 预算更新冲突`)
  }
}

function isBudgetActiveStatus(status: string): boolean {
  return ['queued', 'running', 'clarification_needed', 'waiting_approval'].includes(status)
}
