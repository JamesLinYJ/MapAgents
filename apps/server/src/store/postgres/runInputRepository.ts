// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 运行输入仓库
//
//   文件:       runInputRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformRunInputs,
  platformRuns,
  platformThreads,
} from '../../db/schema.js'
import { runSteeringRecordSchema, type RunSteeringRecord } from '../../schemas/types.js'
import { currentLogContext } from '../../observability/logger.js'
import { estimateTokens } from '../conversationEncoding.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { EnqueueRunInput, RunInputRepository } from './conversationPersistencePorts.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'

/** 运行中用户引导消息的幂等入队、lease 和恢复事实源。 */
export class PostgresRunInputRepository implements RunInputRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
  ) {}

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    const normalized = input.content.trim()
    if (!normalized) throw new Error('引导消息不能为空')
    const traceId = stringContextValue('traceId')
    return this.mutations.run(input.runId, () => this.db.transaction(async tx => {
      const existingRows = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.inputId, input.inputId)).limit(1)
      const existing = existingRows[0]
      if (existing) {
        if (existing.runId !== input.runId || existing.content !== normalized) {
          throw new Error(`引导消息 '${input.inputId}' 的幂等键已被其它内容使用`)
        }
        return mapRunSteeringRow(existing)
      }

      const runRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, input.runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${input.runId}' 不存在`)
      if (run.status !== 'running') throw new Error(`运行 '${input.runId}' 已结束接收引导消息`)
      if (!run.threadId) throw new Error(`运行 '${input.runId}' 缺少 threadId`)
      const inputSequence = run.nextInputSequence

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
      const sequenceState = sequenceRows[0]
      if (!sequenceState) throw new Error(`运行 '${input.runId}' 所属线程不存在`)

      const parentRows = await tx.select({ entryId: platformConversationEntries.entryId })
        .from(platformConversationEntries)
        .where(eq(platformConversationEntries.threadId, run.threadId))
        .orderBy(desc(platformConversationEntries.sequence))
        .limit(1)
      const queuedAt = new Date()
      const payload = { role: 'user', content: normalized, steeringId: input.inputId }
      await tx.insert(platformConversationEntries).values({
        entryId: input.entryId,
        sessionId: sequenceState.sessionId,
        threadId: run.threadId,
        runId: run.runId,
        sequence: sequenceState.nextEntrySequence - 1,
        parentEntryId: parentRows[0]?.entryId ?? null,
        logicalParentEntryId: null,
        kind: 'message',
        payloadJson: payload,
        traceId,
        createdAt: queuedAt,
      })
      await tx.update(platformThreads).set({
        activeLeafEntryId: input.entryId,
        transcriptEntryCount: sequenceState.transcriptEntryCount + 1,
        estimatedContextTokens: sequenceState.estimatedContextTokens + estimateTokens(JSON.stringify(payload)),
      }).where(eq(platformThreads.threadId, run.threadId))
      await tx.insert(platformRunInputs).values({
        inputId: input.inputId,
        runId: run.runId,
        threadId: run.threadId,
        entryId: input.entryId,
        itemId: input.itemId,
        kind: 'steering',
        content: normalized,
        inputSequence,
        status: 'queued',
        queuedAt,
      })
      const sequenceClaim = await tx.update(platformRuns).set({
        nextInputSequence: inputSequence + 1,
        updatedAt: queuedAt,
      }).where(and(
        eq(platformRuns.runId, run.runId),
        eq(platformRuns.nextInputSequence, inputSequence),
      )).returning({ runId: platformRuns.runId })
      if (!sequenceClaim[0]) throw new Error(`运行 '${run.runId}' 的 input sequence CAS 失败`)
      const record = runSteeringRecordSchema.parse({
        schemaVersion: 2,
        steeringId: input.inputId,
        entryId: input.entryId,
        itemId: input.itemId,
        runId: run.runId,
        threadId: run.threadId,
        content: normalized,
        inputSequence,
        status: 'queued',
        queuedAt: queuedAt.toISOString(),
        leaseId: null,
        leasedAt: null,
        ackedAt: null,
      })
      await this.inputDelivery.recordTransition(tx, 'queued', run.runId, run.threadId, [record])
      return record
    }))
  }

  async leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]> {
    if (!leaseId.trim()) throw new Error('run input leaseId 不能为空')
    return this.mutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({
        threadId: platformRuns.threadId,
        checkpointInputCursor: platformRuns.checkpointInputCursor,
        nextInputSequence: platformRuns.nextInputSequence,
        activeInputLeaseId: platformRuns.activeInputLeaseId,
        activeInputLeaseFrom: platformRuns.activeInputLeaseFrom,
        activeInputLeaseTo: platformRuns.activeInputLeaseTo,
      }).from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      if (run.activeInputLeaseId) {
        if (run.activeInputLeaseId !== leaseId) {
          throw new Error(`运行 '${runId}' 已有活动输入 lease '${run.activeInputLeaseId}'`)
        }
        if (run.activeInputLeaseFrom === null || run.activeInputLeaseTo === null) {
          throw new Error(`运行 '${runId}' 的活动输入 lease 范围不完整`)
        }
        const existingLease = await tx.select().from(platformRunInputs)
          .where(and(
            eq(platformRunInputs.runId, runId),
            eq(platformRunInputs.status, 'leased'),
            eq(platformRunInputs.leaseId, leaseId),
          ))
          .orderBy(asc(platformRunInputs.inputSequence))
          .for('update')
        assertContiguousInputPrefix(
          existingLease,
          run.activeInputLeaseFrom,
          run.activeInputLeaseTo - run.activeInputLeaseFrom + 1,
          runId,
        )
        return existingLease.map(mapRunSteeringRow)
      }

      const rows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          gt(platformRunInputs.inputSequence, run.checkpointInputCursor),
          eq(platformRunInputs.status, 'queued'),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      const expectedCount = run.nextInputSequence - run.checkpointInputCursor - 1
      if (!rows.length) {
        if (expectedCount !== 0) {
          throw new Error(`运行 '${runId}' 的 input cursor 与 queued 连续前缀不一致`)
        }
        return []
      }
      assertContiguousInputPrefix(rows, run.checkpointInputCursor + 1, expectedCount, runId)

      const leasedAt = new Date()
      const leaseFrom = rows[0]!.inputSequence
      const leaseTo = rows.at(-1)!.inputSequence
      const claimed = await tx.update(platformRuns)
        .set({
          activeInputLeaseId: leaseId,
          activeInputLeaseFrom: leaseFrom,
          activeInputLeaseTo: leaseTo,
          updatedAt: leasedAt,
        })
        .where(and(
          eq(platformRuns.runId, runId),
          eq(platformRuns.checkpointInputCursor, run.checkpointInputCursor),
          isNull(platformRuns.activeInputLeaseId),
        ))
        .returning({ runId: platformRuns.runId })
      if (!claimed[0]) throw new Error(`运行 '${runId}' 的输入 lease CAS 失败`)
      const leasedRows = await tx.update(platformRunInputs)
        .set({ status: 'leased', leaseId, leasedAt, ackedAt: null })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'queued'),
          gt(platformRunInputs.inputSequence, run.checkpointInputCursor),
        ))
        .returning()
      leasedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertContiguousInputPrefix(leasedRows, leaseFrom, expectedCount, runId)
      const records = leasedRows.map(mapRunSteeringRow)
      await this.inputDelivery.recordTransition(
        tx,
        'leased',
        runId,
        run.threadId ?? rows[0]!.threadId,
        records,
      )
      return records
    }))
  }

  async getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null> {
    const rows = await this.db.select().from(platformRunInputs)
      .where(and(
        eq(platformRunInputs.runId, runId),
        eq(platformRunInputs.inputId, inputId),
      ))
      .limit(1)
    return rows[0] ? mapRunSteeringRow(rows[0]) : null
  }

  async requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    return this.mutations.run(runId, () => this.db.transaction(async tx => {
      const runRows = await tx.select({
        threadId: platformRuns.threadId,
        checkpointInputCursor: platformRuns.checkpointInputCursor,
        activeInputLeaseId: platformRuns.activeInputLeaseId,
        activeInputLeaseFrom: platformRuns.activeInputLeaseFrom,
        activeInputLeaseTo: platformRuns.activeInputLeaseTo,
      }).from(platformRuns)
        .where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      const activeLeaseId = run.activeInputLeaseId
      if (!activeLeaseId) return []
      if (run.activeInputLeaseFrom !== run.checkpointInputCursor + 1 || run.activeInputLeaseTo === null) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 范围不合法`)
      }

      const rows = await tx.select().from(platformRunInputs)
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'leased'),
          eq(platformRunInputs.leaseId, activeLeaseId),
        ))
        .orderBy(asc(platformRunInputs.inputSequence))
        .for('update')
      if (!rows.length) throw new Error(`运行 '${runId}' 的活动输入 lease '${activeLeaseId}' 没有对应记录`)
      const expectedCount = run.activeInputLeaseTo - run.activeInputLeaseFrom + 1
      assertContiguousInputPrefix(rows, run.activeInputLeaseFrom, expectedCount, runId)
      const requeuedRows = await tx.update(platformRunInputs)
        .set({ status: 'queued', leaseId: null, leasedAt: null, ackedAt: null })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'leased'),
          eq(platformRunInputs.leaseId, activeLeaseId),
        ))
        .returning()
      requeuedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertContiguousInputPrefix(requeuedRows, run.activeInputLeaseFrom, expectedCount, runId)
      const released = await tx.update(platformRuns)
        .set({
          activeInputLeaseId: null,
          activeInputLeaseFrom: null,
          activeInputLeaseTo: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(platformRuns.runId, runId),
          eq(platformRuns.activeInputLeaseId, activeLeaseId),
        ))
        .returning({ runId: platformRuns.runId })
      if (!released[0]) throw new Error(`运行 '${runId}' 的输入 lease 恢复 CAS 失败`)
      const records = requeuedRows.map(mapRunSteeringRow)
      await this.inputDelivery.recordTransition(
        tx,
        'requeued',
        runId,
        run.threadId ?? rows[0]!.threadId,
        records,
      )
      return records
    }))
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    const rows = await this.db.select().from(platformRunInputs)
      .where(eq(platformRunInputs.runId, runId))
      .orderBy(asc(platformRunInputs.inputSequence))
    return rows.map(mapRunSteeringRow)
  }
}

export function mapRunSteeringRow(row: {
  inputId: string
  entryId: string
  itemId: string
  runId: string
  threadId: string
  content: string
  inputSequence: number
  status: string
  queuedAt: Date
  leaseId: string | null
  leasedAt: Date | null
  ackedAt: Date | null
}): RunSteeringRecord {
  return runSteeringRecordSchema.parse({
    schemaVersion: 2,
    steeringId: row.inputId,
    entryId: row.entryId,
    itemId: row.itemId,
    runId: row.runId,
    threadId: row.threadId,
    content: row.content,
    inputSequence: row.inputSequence,
    status: row.status,
    queuedAt: row.queuedAt.toISOString(),
    leaseId: row.leaseId,
    leasedAt: row.leasedAt?.toISOString() ?? null,
    ackedAt: row.ackedAt?.toISOString() ?? null,
  })
}

function assertContiguousInputPrefix(
  rows: readonly { inputSequence: number }[],
  firstSequence: number,
  expectedCount: number,
  runId: string,
): void {
  if (rows.length !== expectedCount) {
    throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
  }
  rows.forEach((row, index) => {
    if (row.inputSequence !== firstSequence + index) {
      throw new Error(`运行 '${runId}' 的 input sequence 存在空洞`)
    }
  })
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
