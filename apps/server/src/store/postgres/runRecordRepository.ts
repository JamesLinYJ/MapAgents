// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运行记录流持久化
//
//   文件:       runRecordRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       runRepository.ts 的 Item、Event、Tool Value 与 outbox 边界
// --------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm'

import {
  conversationItemSchema,
  runEventSchema,
  toolValueRefSchema,
  type ConversationItem,
  type RunEvent,
  type ToolValueRef,
} from '../../schemas/types.js'
import { summarizeAssistantText } from '../../conversation/items.js'
import type { Database } from '../../db/connection.js'
import { platformEventOutbox, platformRunRecords, platformRuns, platformThreads } from '../../db/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import { makeId } from '../../utils/ids.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { RunRecordRepository } from './conversationPersistencePorts.js'
import type { RunRecordAppender } from './runRecordAppender.js'

/** Run Item、Event、Tool Value 与实时 outbox 的原子追加边界。 */
export class PostgresRunRecordRepository implements RunRecordRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly runRecords: RunRecordAppender,
  ) {}

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
      await this.runRecords.append(tx, parsed.runId, run.threadId, [{ recordType: 'item', payloadJson: parsed }], traceId)

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
      await this.runRecords.append(tx, runId, run.threadId ?? threadId, [{ recordType, payloadJson }], traceId)
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

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
