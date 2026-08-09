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

import { and, asc, eq, isNull } from 'drizzle-orm'

import { runCheckpointSchema, type RunCheckpoint, type RunSteeringRecord } from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import { platformRunInputs, platformRuns } from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { RunCheckpointRepository } from './conversationPersistencePorts.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'
import type { RunInputDeliveryRecorder } from './runInputDeliveryRecorder.js'
import { mapRunSteeringRow } from './runInputRepository.js'

/** Run 恢复字段和 Agents SDK 状态引用的唯一持久化边界。 */
export class PostgresRunCheckpointRepository implements RunCheckpointRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly inputDelivery: RunInputDeliveryRecorder,
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
      const runRows = await tx.select({
        threadId: platformRuns.threadId,
        sdkStateContentHash: platformRuns.sdkStateContentHash,
        checkpointInputCursor: platformRuns.checkpointInputCursor,
        activeInputLeaseId: platformRuns.activeInputLeaseId,
        activeInputLeaseFrom: platformRuns.activeInputLeaseFrom,
        activeInputLeaseTo: platformRuns.activeInputLeaseTo,
        pendingToolCallIds: platformRuns.pendingToolCallIds,
      }).from(platformRuns).where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)

      const updatedAt = new Date()
      const terminalToolCallIds = new Set(input.terminalToolCallIds ?? [])
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
          .returning({ runId: platformRuns.runId })
        if (!rows[0]) throw new Error(`运行 '${runId}' 不存在`)
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
      const isIdempotentAck = run.activeInputLeaseId === null
        && leasedRows.every(row => row.status === 'acked')
        && lastSequence <= run.checkpointInputCursor
      if (isIdempotentAck) {
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
          )).returning({ runId: platformRuns.runId })
          if (!rows[0]) throw new Error(`运行 '${runId}' 的工具终态 checkpoint CAS 失败`)
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
      if (leasedRows.some(row => row.status !== 'leased')) {
        throw new Error(`运行 '${runId}' 的活动输入 lease 包含非 leased 记录`)
      }

      const ackedRows = await tx.update(platformRunInputs)
        .set({ status: 'acked', ackedAt: updatedAt })
        .where(and(
          eq(platformRunInputs.runId, runId),
          eq(platformRunInputs.status, 'leased'),
          eq(platformRunInputs.leaseId, leaseId),
        ))
        .returning()
      ackedRows.sort((left, right) => left.inputSequence - right.inputSequence)
      assertAckPrefix(
        ackedRows,
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
      )).returning({ runId: platformRuns.runId })
      if (!checkpointRows[0]) throw new Error(`运行 '${runId}' 的 checkpoint/input cursor CAS 失败`)

      await this.inputDelivery.recordAcknowledged(
        tx,
        runId,
        run.threadId ?? ackedRows[0]?.threadId ?? null,
        ackedRows.map(mapRunSteeringRow),
      )

      return ackedRows.map(mapRunSteeringRow)
    }))
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
