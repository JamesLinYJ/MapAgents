// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 运行输入仓库
//
//   文件:       runInputRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformEventOutbox,
  platformRunInputs,
  platformRuns,
  platformThreads,
} from '../../db/schema.js'
import { runSteeringRecordSchema, type RunSteeringRecord } from '../../schemas/types.js'
import { currentLogContext } from '../../observability/logger.js'
import { makeId } from '../../utils/ids.js'
import { estimateTokens } from '../conversationEncoding.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { EnqueueRunInput, RunInputRepository } from './conversationPersistencePorts.js'
import type { RunRecordAppender } from './runRecordAppender.js'

/** 运行中用户引导消息的幂等入队、消费和审计事实源。 */
export class PostgresRunInputRepository implements RunInputRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: RunMutationQueue,
    private readonly runRecords: RunRecordAppender,
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
        return steeringRecord(existing)
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
        status: 'queued',
        queuedAt,
      })
      await this.runRecords.append(tx, run.runId, run.threadId, [{
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
    return this.mutations.run(runId, () => this.db.transaction(async tx => {
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
      await this.runRecords.append(
        tx,
        runId,
        run.threadId ?? rows[0]!.threadId,
        rows.map(row => ({
          recordType: 'input.consumed',
          payloadJson: { inputId: row.inputId, entryId: row.entryId, itemId: row.itemId },
        })),
        traceId,
      )
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

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
