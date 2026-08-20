// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Result 单事务提交
//
//   文件:       toolResultCommitRepository.ts
//
//   Tool Value、Run 状态、Artifact 元数据/地图投影和 Outbox 必须共享同一
//   PostgreSQL 事务；文件系统只在事务成功后由上层发布。
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformEventOutbox, platformRuns, platformToolResultCommits } from '../../db/schema.js'
import type { AnalysisRun, ArtifactRef, ToolValueRef } from '../../schemas/types.js'
import { currentLogContext } from '../../observability/logger.js'
import { makeId } from '../../utils/ids.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import {
  assertRunDomainCheckpointProjection,
  assertRunDomainProjection,
  buildRunTransitionEvents,
  toRunDomainCheckpoint,
} from '../runDomainProjection.js'
import {
  mapAnalysisRunRow,
  toRunInsertValues,
  toRunUpdateValues,
} from './conversationRowMappers.js'
import { ArtifactPublicationRepository } from './artifactPublicationRepository.js'
import { RunRecordAppender } from './runRecordAppender.js'
import type { PostgresRunDomainJournalRepository } from './runDomainJournalRepository.js'

export class PostgresToolResultCommitRepository {
  private readonly artifactPublication: ArtifactPublicationRepository
  private readonly runRecords = new RunRecordAppender()

  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
    private readonly domainJournal: PostgresRunDomainJournalRepository,
  ) {
    this.artifactPublication = new ArtifactPublicationRepository(db)
  }

  async commit(
    run: AnalysisRun,
    resultId: string,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<boolean> {
    return this.runMutations.run(run.id, () => this.db.transaction(async tx => {
      const claimed = await tx.insert(platformToolResultCommits).values({
        runId: run.id,
        resultId,
      }).onConflictDoNothing().returning({ resultId: platformToolResultCommits.resultId })
      if (!claimed[0]) return false

      const runRows = await tx.select()
        .from(platformRuns)
        .where(eq(platformRuns.runId, run.id))
        .for('update')
        .limit(1)
      const persistedRun = runRows[0]
      if (!persistedRun) throw new Error(`运行 '${run.id}' 不存在`)
      if (persistedRun.threadId !== run.threadId) {
        throw new Error(`运行 '${run.id}' 的 threadId 与内存状态不一致`)
      }

      const currentSnapshot = await this.domainJournal.requireSnapshotInTransaction(tx, run.id)
      const updatedRows = await tx.update(platformRuns)
        .set(toRunUpdateValues(toRunInsertValues(run)))
        .where(eq(platformRuns.runId, run.id))
        .returning()
      const updatedRow = updatedRows[0]
      if (!updatedRow) throw new Error(`运行 '${run.id}' 不存在`)
      const persistedAfter = mapAnalysisRunRow(updatedRow)
      const domainEvents = buildRunTransitionEvents({
        before: mapAnalysisRunRow(persistedRun),
        after: persistedAfter,
        expectedSequence: currentSnapshot.sequence,
        reason: 'tool_result_committed',
        resultId,
      })
      const domainSnapshot = await this.domainJournal.appendInTransaction(tx, {
        runId: run.id,
        expectedSequence: currentSnapshot.sequence,
        events: domainEvents,
      })
      assertRunDomainProjection(domainSnapshot, persistedAfter)
      assertRunDomainCheckpointProjection(domainSnapshot, toRunDomainCheckpoint(updatedRow))

      const traceId = stringContextValue('traceId')
      await this.runRecords.append(
        tx,
        run.id,
        persistedRun.threadId,
        values.map(value => ({ recordType: 'value', payloadJson: value })),
        traceId,
      )
      await tx.insert(platformEventOutbox).values({
        outboxId: makeId('outbox'),
        aggregateType: 'run',
        aggregateId: run.id,
        eventType: 'run.tool_result.committed',
        payloadJson: {
          resultId,
          valueRefIds: values.map(value => value.refId),
          artifactIds: artifacts.map(artifact => artifact.artifactId),
        },
        traceId,
      })

      const owner = {
        workspaceId: run.workspaceId,
        createdByUserId: run.createdByUserId,
        visibility: run.visibility,
        threadId: run.threadId,
        runCreatedAt: run.createdAt,
      }
      for (const artifact of artifacts) {
        await this.artifactPublication.persistInTransaction(tx, artifact, owner)
      }
      return true
    }))
  }
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}
