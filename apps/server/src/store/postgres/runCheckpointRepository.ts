// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行检查点持久化
//
//   文件:       runCheckpointRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       runRepository.ts 的恢复状态与 Agents SDK checkpoint 边界
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  runCheckpointSchema,
  type RunCheckpoint,
  type RunDomainSnapshot,
  type RunSteeringRecord,
} from '../../schemas/types.js'
import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformRunInputs, platformRuns, platformToolInvocations } from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainInputProjection,
  assertRunDomainProjection,
  buildCheckpointChangedEvent,
  buildInputTransitionEvent,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import type { RunCheckpointRepository } from './conversationPersistencePorts.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import { mapRunSteeringRow } from './runInputRepository.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

/** Run 恢复字段和 Agents SDK 状态引用的唯一持久化边界。 */
export class PostgresRunCheckpointRepository implements RunCheckpointRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {}

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const updates: Partial<typeof platformRuns.$inferInsert> = { updatedAt: new Date() }
    if (fields.activeEntryId !== undefined) updates.activeEntryId = fields.activeEntryId
    if (fields.pendingToolCallIds !== undefined) updates.pendingToolCallIds = fields.pendingToolCallIds
    if (fields.recoveryStatus !== undefined) updates.recoveryStatus = fields.recoveryStatus
    await this.runMutations.run(runId, async () => {
      await this.db.transaction(async tx => {
        const beforeRows = await tx.select().from(platformRuns)
          .where(eq(platformRuns.runId, runId)).for('update').limit(1)
        if (!beforeRows[0]) throw new Error(`运行 '${runId}' 不存在`)
        const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)
        const rows = await tx.update(platformRuns).set(updates)
          .where(eq(platformRuns.runId, runId))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${runId}' 不存在`)
        await this.appendCheckpointProjection(tx, currentSnapshot, afterRow)
      })
    })
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    const rows = await this.db.select().from(platformRuns)
      .where(eq(platformRuns.runId, runId)).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`运行 '${runId}' 不存在`)
    return runCheckpointSchema.parse({
      schemaVersion: 2,
      run: mapAnalysisRunRow(row),
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
      nextInputSequence: row.nextInputSequence,
      checkpointInputCursor: row.checkpointInputCursor,
      activeInputLeaseId: row.activeInputLeaseId,
      activeInputLeaseFrom: row.activeInputLeaseFrom,
      activeInputLeaseTo: row.activeInputLeaseTo,
      terminalInputClaimId: row.terminalInputClaimId,
      terminalObjectiveRevision: row.terminalObjectiveRevision,
      terminalInputCursor: row.terminalInputCursor,
      terminalClaimedAt: row.terminalClaimedAt?.toISOString() ?? null,
    })
  }

  async saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
    inputLeaseId?: string | null
    terminalToolCallIds?: readonly string[]
  }): Promise<RunSteeringRecord[]> {
    return this.runMutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, runId)

      const updatedAt = new Date()
      const terminalToolCallIds = new Set(input.terminalToolCallIds ?? [])
      await checkpointToolInvocations(tx, runId, terminalToolCallIds, updatedAt)
      const pendingToolCallIds = run.pendingToolCallIds
        .filter(callId => !terminalToolCallIds.has(callId))
      const checkpointFields = {
        orchestrationEngine: 'openai_agents' as const,
        sdkStateContentHash: input.contentHash,
        sdkVersion: input.agentsSdkVersion,
        runtimeConfigDigest: input.runtimeConfigDigest,
        sdkStateSchemaVersion: input.sdkStateSchemaVersion,
        sdkStateUpdatedAt: updatedAt,
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' as const : 'clean' as const,
        updatedAt,
      }
      const leaseId = input.inputLeaseId ?? null
      if (!leaseId) {
        if (run.activeInputLeaseId) {
          throw new Error(
            `运行 '${runId}' 存在未确认输入 lease '${run.activeInputLeaseId}'，`
            + '禁止挂载不带 input ack 的 SDK checkpoint',
          )
        }
        const rows = await tx.update(platformRuns).set(checkpointFields)
          .where(and(
            eq(platformRuns.runId, runId),
            eq(platformRuns.checkpointInputCursor, run.checkpointInputCursor),
            isNull(platformRuns.activeInputLeaseId),
          ))
          .returning()
        const afterRow = rows[0]
        if (!afterRow) throw new Error(`运行 '${runId}' 不存在`)
        await this.appendCheckpointProjection(tx, currentSnapshot, afterRow)
        return []
      }

      const leasedRows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.leaseId, leaseId),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      if (!leasedRows.length) {
        throw new Error(`运行 '${runId}' 的输入 lease '${leaseId}' 不存在`)
      }

      const lastSequence = leasedRows.at(-1)!.inputSequence
      const isIdempotentCheckpoint = run.activeInputLeaseId === null
        && leasedRows.every(row => row.status === 'checkpointed')
        && lastSequence <= run.checkpointInputCursor
      if (isIdempotentCheckpoint) {
        if (run.sdkStateContentHash !== input.contentHash) {
          throw new Error(`运行 '${runId}' 的旧输入 lease '${leaseId}' 不能覆盖更新的 SDK checkpoint`)
        }
        if (pendingToolCallIds.length !== run.pendingToolCallIds.length) {
          const rows = await tx.update(platformRuns).set({
            pendingToolCallIds,
            recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
            updatedAt,
          }).where(and(
            eq(platformRuns.runId, runId),
            eq(platformRuns.sdkStateContentHash, input.contentHash),
            isNull(platformRuns.activeInputLeaseId),
          )).returning()
          const afterRow = rows[0]
          if (!afterRow) throw new Error(`运行 '${runId}' 的工具终态 checkpoint CAS 失败`)
          await this.appendCheckpointProjection(tx, currentSnapshot, afterRow)
        } else {
          const persistedRun = mapAnalysisRunRow(run)
          assertRunDomainProjection(currentSnapshot, persistedRun)
          assertRunDomainCheckpointProjection(currentSnapshot, toRunDomainCheckpoint(run))
        }
        return leasedRows.map(mapRunSteeringRow)
      }

      if (run.activeInputLeaseId !== leaseId) {
        throw new Error(
          `运行 '${runId}' 的活动输入 lease 与 checkpoint 不一致：`
          + `${run.activeInputLeaseId ?? 'none'} != ${leaseId}`,
        )
      }
      if (
        run.activeInputLeaseFrom !== run.checkpointInputCursor + 1
        || run.activeInputLeaseTo === null
      ) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 范围不合法`)
      }
      assertAckPrefix(
        leasedRows,
        run.activeInputLeaseFrom,
        run.activeInputLeaseTo - run.activeInputLeaseFrom + 1,
        runId,
      )
      if (leasedRows.some(row => row.status !== 'included')) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 尚未绑定精确 ModelRequest`)
      }

      const checkpointedRows = await tx.update(platformRunInputs)
        .set({ status: 'checkpointed', checkpointedAt: updatedAt })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'included'),
          eq(platformRunInputs.leaseId, leaseId),
        ))
        .returning()
      checkpointedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertAckPrefix(
        checkpointedRows,
        run.activeInputLeaseFrom,
        run.activeInputLeaseTo - run.activeInputLeaseFrom + 1,
        runId,
      )
      const checkpointRows = await tx.update(platformRuns).set({
        ...checkpointFields,
        checkpointInputCursor: lastSequence,
        activeInputLeaseId: null,
        activeInputLeaseFrom: null,
        activeInputLeaseTo: null,
      }).where(and(
        eq(platformRuns.runId, runId),
        eq(platformRuns.checkpointInputCursor, run.checkpointInputCursor),
        eq(platformRuns.activeInputLeaseId, leaseId),
      )).returning()
      const afterRow = checkpointRows[0]
      if (!afterRow) throw new Error(`运行 '${runId}' 的 checkpoint/input cursor CAS 失败`)

      await this.inputDelivery.recordCheckpointed(
        tx,
        runId,
        run.threadId ?? checkpointedRows[0]?.threadId ?? null,
        checkpointedRows.map(mapRunSteeringRow),
      )

      await this.appendCheckpointProjection(
        tx,
        currentSnapshot,
        afterRow,
        checkpointedRows.map(mapRunSteeringRow),
      )

      return checkpointedRows.map(mapRunSteeringRow)
    }))
  }

  private async appendCheckpointProjection(
    tx: DatabaseTransaction,
    currentSnapshot: RunDomainSnapshot,
    afterRow: typeof platformRuns.$inferSelect,
    acknowledged: readonly RunSteeringRecord[] = [],
  ): Promise<void> {
    const run = mapAnalysisRunRow(afterRow)
    const checkpoint = toRunDomainCheckpoint(afterRow)
    const events = []
    if (acknowledged.length) {
      events.push(buildInputTransitionEvent({
        run,
        expectedSequence: currentSnapshot.sequence,
        type: 'input.checkpointed',
        records: acknowledged,
      }))
    }
    if (!isDeepStrictEqual(currentSnapshot.checkpoint, checkpoint)) {
      events.push(buildCheckpointChangedEvent({
        run,
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
    assertRunDomainProjection(snapshot, run)
    assertRunDomainCheckpointProjection(snapshot, checkpoint)
    if (acknowledged.length) assertRunDomainInputProjection(snapshot, acknowledged)
  }
}

async function checkpointToolInvocations(
  tx: DatabaseTransaction,
  runId: string,
  callIds: ReadonlySet<string>,
  checkpointedAt: Date,
): Promise<void> {
  if (!callIds.size) return
  const rows = await tx.select().from(platformToolInvocations)
    .where(and(
      eq(platformToolInvocations.runId, runId),
      inArray(platformToolInvocations.callId, [...callIds]),
    ))
    .for('update')
  const byCallId = new Map(rows.map(row => [row.callId, row]))
  const missing = [...callIds].filter(callId => !byCallId.has(callId))
  if (missing.length) {
    throw new Error(`SDK checkpoint 引用了不存在的工具调用：${missing.join('、')}`)
  }
  const invalid = rows.filter(row => ![
    'succeeded',
    'failed',
    'rejected',
    'aborted',
    'checkpointed',
  ].includes(row.status))
  if (invalid.length) {
    throw new Error(
      `SDK checkpoint 不能确认非终态工具调用：`
      + invalid.map(row => `${row.callId}=${row.status}`).join('、'),
    )
  }
  const terminal = rows.filter(row => row.status !== 'checkpointed')
  if (!terminal.length) return
  const updated = await tx.update(platformToolInvocations).set({
    status: 'checkpointed',
    checkpointedAt,
    version: sql`${platformToolInvocations.version} + 1`,
  }).where(and(
    eq(platformToolInvocations.runId, runId),
    inArray(platformToolInvocations.invocationId, terminal.map(row => row.invocationId)),
    inArray(platformToolInvocations.status, ['succeeded', 'failed', 'rejected', 'aborted']),
  )).returning({ invocationId: platformToolInvocations.invocationId })
  if (updated.length !== terminal.length) {
    throw new Error(`运行 '${runId}' 的工具调用 checkpoint CAS 失败`)
  }
}

function assertAckPrefix(
  rows: readonly { inputSequence: number }[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (rows.length !== expectedCount) {
    throw new Error(`运行 '${runId}' 的 checkpoint ack 不是连续输入前缀`)
  }
  rows.forEach((row, index) => {
    if (row.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的 checkpoint ack 不是连续输入前缀`)
    }
  })
}
