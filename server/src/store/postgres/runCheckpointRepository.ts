// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运行检查点持久化
//
//   文件:       runCheckpointRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
//   来源:       runRepository.ts 的恢复状态与 Agents SDK checkpoint 边界
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import { runCheckpointSchema, type RunCheckpoint } from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import { platformRuns } from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type { RunCheckpointRepository } from './conversationPersistencePorts.js'
import { mapAnalysisRunRow } from './conversationRowMappers.js'

/** Run 恢复字段和 Agents SDK 状态引用的唯一持久化边界。 */
export class PostgresRunCheckpointRepository implements RunCheckpointRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
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
    })
  }

  async saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
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
}
