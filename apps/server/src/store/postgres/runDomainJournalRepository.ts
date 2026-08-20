// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL Run 领域日志仓库
//
//   文件:       runDomainJournalRepository.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, eq, gt } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import {
  platformRunDomainEvents,
  platformRunInputs,
  platformRuns,
  platformRunSnapshots,
} from '../../db/schema.js'
import {
  reduceRunDomainEvents,
  runDomainEventSchema,
  runDomainInputDeliverySchema,
  runDomainSnapshotSchema,
  type RunDomainEvent,
  type RunDomainSnapshot,
} from '../../schemas/types.js'
import { RunDomainSequenceConflictError } from '../storeErrors.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainInputCollection,
  assertRunDomainProjection,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'
import type {
  AppendRunDomainEventsInput,
  RunDomainJournalRepository,
} from './conversationPersistencePorts.js'

/**
 * 领域事件与 reducer snapshot 的唯一写入边界。
 * 调用方若已经持有 platform_runs 行锁，应使用 appendInTransaction；
 * 对外 CAS API 则在这里取得同一行锁，二者不会产生 LWW。
 */
export class PostgresRunDomainJournalRepository implements RunDomainJournalRepository {
  constructor(private readonly db: Database) {}

  appendRunDomainEvents(input: AppendRunDomainEventsInput): Promise<RunDomainSnapshot> {
    return this.db.transaction(async tx => {
      const rows = await tx.select()
        .from(platformRuns)
        .where(eq(platformRuns.runId, input.runId))
        .for('update')
        .limit(1)
      const runRow = rows[0]
      if (!runRow) throw new Error(`运行 '${input.runId}' 不存在`)
      const snapshot = await this.appendInTransaction(tx, input)
      assertRunDomainProjection(snapshot, mapAnalysisRunRow(runRow))
      assertRunDomainCheckpointProjection(snapshot, toRunDomainCheckpoint(runRow))
      const inputRows = await tx.select().from(platformRunInputs)
        .where(eq(platformRunInputs.runId, input.runId))
        .orderBy(asc(platformRunInputs.inputSequence))
      assertRunDomainInputCollection(snapshot, inputRows.map(row => runDomainInputDeliverySchema.parse({
        inputId: row.inputId,
        inputSequence: row.inputSequence,
        status: row.status,
        leaseId: row.status === 'queued' ? null : row.leaseId,
      })))
      return snapshot
    })
  }

  async getRunDomainSnapshot(runId: string): Promise<RunDomainSnapshot | null> {
    const rows = await this.db.select().from(platformRunSnapshots)
      .where(eq(platformRunSnapshots.runId, runId))
      .limit(1)
    return rows[0] ? mapSnapshotRow(rows[0]) : null
  }

  async listRunDomainEvents(runId: string, afterSequence = 0): Promise<RunDomainEvent[]> {
    const condition = afterSequence > 0
      ? and(
        eq(platformRunDomainEvents.runId, runId),
        gt(platformRunDomainEvents.sequence, afterSequence),
      )
      : eq(platformRunDomainEvents.runId, runId)
    const rows = await this.db.select().from(platformRunDomainEvents)
      .where(condition)
      .orderBy(asc(platformRunDomainEvents.sequence))
    return rows.map(mapEventRow)
  }

  async requireSnapshotInTransaction(
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<RunDomainSnapshot> {
    const snapshot = await this.getSnapshotInTransaction(tx, runId)
    if (!snapshot) {
      throw new Error(
        `run '${runId}' 缺少领域日志 snapshot；数据库 migration 013 未完整回填`,
      )
    }
    return snapshot
  }

  async getSnapshotInTransaction(
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<RunDomainSnapshot | null> {
    const rows = await tx.select().from(platformRunSnapshots)
      .where(eq(platformRunSnapshots.runId, runId))
      .for('update')
      .limit(1)
    return rows[0] ? mapSnapshotRow(rows[0]) : null
  }

  async appendInTransaction(
    tx: DatabaseTransaction,
    input: AppendRunDomainEventsInput,
  ): Promise<RunDomainSnapshot> {
    if (!input.events.length) throw new Error('Run 领域日志 append 不能为空')
    if (!Number.isInteger(input.expectedSequence) || input.expectedSequence < 0) {
      throw new Error('Run 领域日志 expectedSequence 必须是非负整数')
    }
    const events = input.events.map(event => runDomainEventSchema.parse(event))
    for (const [index, event] of events.entries()) {
      if (event.runId !== input.runId) {
        throw new Error(`领域事件 '${event.eventId}' 不属于 run '${input.runId}'`)
      }
      const expectedEventSequence = input.expectedSequence + index + 1
      if (event.sequence !== expectedEventSequence) {
        throw new Error(
          `领域事件 '${event.eventId}' sequence 应为 ${expectedEventSequence}，`
          + `实际为 ${event.sequence}`,
        )
      }
    }

    const current = await this.getSnapshotInTransaction(tx, input.runId)
    const currentSequence = current?.sequence ?? 0
    if (currentSequence !== input.expectedSequence) {
      throw new RunDomainSequenceConflictError(
        input.runId,
        input.expectedSequence,
        currentSequence,
      )
    }
    const next = reduceRunDomainEvents(current, events)
    if (!next) throw new Error(`run '${input.runId}' 领域日志没有产生 snapshot`)

    await tx.insert(platformRunDomainEvents).values(events.map(event => ({
      eventId: event.eventId,
      runId: event.runId,
      sequence: event.sequence,
      eventType: event.type,
      schemaVersion: event.schemaVersion,
      objectiveRevision: event.objectiveRevision,
      turnId: event.turnId,
      stepId: event.stepId,
      causationId: event.causationId,
      correlationId: event.correlationId,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      payloadJson: event.payload,
      occurredAt: new Date(event.occurredAt),
    })))
    await tx.insert(platformRunSnapshots).values({
      runId: next.runId,
      sequence: next.sequence,
      snapshotSchemaVersion: next.schemaVersion,
      stateJson: next,
      updatedAt: new Date(next.updatedAt),
    }).onConflictDoUpdate({
      target: platformRunSnapshots.runId,
      set: {
        sequence: next.sequence,
        snapshotSchemaVersion: next.schemaVersion,
        stateJson: next,
        updatedAt: new Date(next.updatedAt),
      },
    })
    return next
  }
}

function mapEventRow(row: typeof platformRunDomainEvents.$inferSelect): RunDomainEvent {
  return runDomainEventSchema.parse({
    eventId: row.eventId,
    runId: row.runId,
    sequence: row.sequence,
    turnId: row.turnId,
    stepId: row.stepId,
    objectiveRevision: row.objectiveRevision,
    causationId: row.causationId,
    correlationId: row.correlationId,
    actor: { kind: row.actorKind, id: row.actorId },
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    type: row.eventType,
    payload: row.payloadJson,
  })
}

function mapSnapshotRow(row: typeof platformRunSnapshots.$inferSelect): RunDomainSnapshot {
  return runDomainSnapshotSchema.parse(row.stateJson)
}
