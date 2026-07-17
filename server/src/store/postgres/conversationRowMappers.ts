// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 会话数据库行映射
//
//   文件:       conversationRowMappers.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  agentThreadRecordSchema,
  analysisRunSchema,
  compactionRecordSchema,
  sessionRecordSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type AnalysisRun,
  type CompactionRecord,
  type SessionRecord,
  type ThreadManifest,
  type TranscriptEntry,
} from '../../schemas/types.js'
import {
  platformRuns,
  platformSessions,
  platformThreadCompactions,
  platformThreadMemoryVersions,
  platformThreads,
} from '../../db/schema.js'
import type {
  DeletedThreadRecord,
  ThreadMemoryVersionReference,
} from './conversationPersistencePorts.js'

export function mapAnalysisRunRow(row: typeof platformRuns.$inferSelect): AnalysisRun {
  return analysisRunSchema.parse({
    id: row.runId,
    sessionId: row.sessionId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    userQuery: row.userQuery,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: row.stateJson,
    runtimeConfigSnapshot: row.runtimeConfigJson,
    conversationPath: null,
  })
}

export function mapSessionRow(row: typeof platformSessions.$inferSelect): SessionRecord {
  return sessionRecordSchema.parse({
    id: row.sessionId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    shareToken: row.shareToken,
    latestThreadId: row.latestThreadId,
    latestRunId: row.latestRunId,
    latestUploadedLayerKey: row.latestUploadedLayerKey,
    latestMeteorologicalDatasetId: row.latestMeteorologicalDatasetId,
  })
}

export function toThreadInsertValues(thread: AgentThreadRecord): typeof platformThreads.$inferInsert {
  return {
    threadId: thread.id,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    title: thread.title,
    status: thread.status,
    latestRunId: thread.latestRunId,
    latestUserQuery: thread.latestUserQuery,
    latestAssistantSummary: thread.latestAssistantSummary,
    latestRunStatus: thread.latestRunStatus,
    latestArtifactId: thread.latestArtifactId,
    latestArtifactName: thread.latestArtifactName,
    historyPreview: thread.historyPreview,
    runCount: thread.runCount,
    deletedAt: null,
    purgeAfter: null,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
  }
}

export function toRunInsertValues(run: AnalysisRun): typeof platformRuns.$inferInsert {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    threadId: run.threadId,
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    stateJson: run.state,
    runtimeConfigJson: run.runtimeConfigSnapshot,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  }
}

export function toRunUpdateValues(
  values: typeof platformRuns.$inferInsert,
): Partial<typeof platformRuns.$inferInsert> {
  return {
    sessionId: values.sessionId,
    threadId: values.threadId,
    workspaceId: values.workspaceId,
    createdByUserId: values.createdByUserId,
    visibility: values.visibility,
    userQuery: values.userQuery,
    modelProvider: values.modelProvider,
    modelName: values.modelName,
    status: values.status,
    stateJson: values.stateJson,
    runtimeConfigJson: values.runtimeConfigJson,
    updatedAt: values.updatedAt,
  }
}

export function assertThreadOwnerMatchesSession(
  thread: AgentThreadRecord,
  session: typeof platformSessions.$inferSelect,
): void {
  if (
    thread.workspaceId !== session.workspaceId
    || thread.createdByUserId !== session.createdByUserId
    || thread.visibility !== session.visibility
  ) {
    throw new Error(`线程 '${thread.id}' 的资源归属与会话 '${session.sessionId}' 不一致`)
  }
}

export function assertRunOwnerMatchesThread(
  run: AnalysisRun,
  thread: typeof platformThreads.$inferSelect,
): void {
  if (
    run.workspaceId !== thread.workspaceId
    || run.createdByUserId !== thread.createdByUserId
    || run.visibility !== thread.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与线程 '${thread.threadId}' 不一致`)
  }
}

export function assertRunOwnerMatchesSession(
  run: AnalysisRun,
  session: typeof platformSessions.$inferSelect,
): void {
  if (
    run.workspaceId !== session.workspaceId
    || run.createdByUserId !== session.createdByUserId
    || run.visibility !== session.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与会话 '${session.sessionId}' 不一致`)
  }
}

export function mapTranscriptEntryRow(row: {
  entryId: string
  sequence: number
  parentEntryId: string | null
  logicalParentEntryId: string | null
  threadId: string
  runId: string | null
  turnId: string | null
  kind: string
  payloadJson: Record<string, unknown>
  createdAt: Date
}): TranscriptEntry {
  return transcriptEntrySchema.parse({
    schemaVersion: 2,
    seq: row.sequence,
    entryId: row.entryId,
    parentEntryId: row.parentEntryId,
    logicalParentEntryId: row.logicalParentEntryId,
    threadId: row.threadId,
    runId: row.runId,
    turnId: row.turnId,
    kind: row.kind,
    timestamp: row.createdAt.toISOString(),
    payload: row.payloadJson,
  })
}

export function mapThreadManifestRow(row: {
  threadId: string
  sessionId: string
  activeLeafEntryId: string | null
  nextEntrySequence: number
  transcriptEntryCount: number
  estimatedContextTokens: number
  latestCompactionId: string | null
  memoryVersion: number
  memoryBasedOnTokens: number
  forkedFromThreadId: string | null
  forkedFromEntryId: string | null
  quarantined: boolean
  quarantineReason: string | null
  createdAt: Date
  updatedAt: Date
}): ThreadManifest {
  return threadManifestSchema.parse({
    schemaVersion: 2,
    threadId: row.threadId,
    sessionId: row.sessionId,
    activeLeafEntryId: row.activeLeafEntryId,
    lastSequence: row.nextEntrySequence - 1,
    transcriptEntryCount: row.transcriptEntryCount,
    estimatedContextTokens: row.estimatedContextTokens,
    latestCompactionId: row.latestCompactionId,
    memoryVersion: row.memoryVersion,
    memoryBasedOnTokens: row.memoryBasedOnTokens,
    forkedFrom: row.forkedFromThreadId && row.forkedFromEntryId
      ? { threadId: row.forkedFromThreadId, entryId: row.forkedFromEntryId }
      : null,
    quarantined: row.quarantined,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function mapThreadRow(row: typeof platformThreads.$inferSelect): AgentThreadRecord {
  return agentThreadRecordSchema.parse({
    id: row.threadId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestRunId: row.latestRunId,
    latestUserQuery: row.latestUserQuery,
    latestAssistantSummary: row.latestAssistantSummary,
    latestRunStatus: row.latestRunStatus,
    latestArtifactId: row.latestArtifactId,
    latestArtifactName: row.latestArtifactName,
    historyPreview: row.historyPreview,
    runCount: row.runCount,
    conversationPath: null,
  })
}

export function mapDeletedThreadRow(row: typeof platformThreads.$inferSelect): DeletedThreadRecord {
  if (!row.deletedAt || !row.purgeAfter) {
    throw new Error(`已删除线程 '${row.threadId}' 缺少回收站时间信息`)
  }
  return {
    thread: mapThreadRow(row),
    manifest: mapThreadManifestRow(row),
    deletedAt: row.deletedAt.toISOString(),
    purgeAfter: row.purgeAfter.toISOString(),
  }
}

export function mapThreadMemoryVersionRow(
  row: typeof platformThreadMemoryVersions.$inferSelect,
): ThreadMemoryVersionReference {
  const source = threadMemoryDocumentSchema.shape.source.parse(row.source)
  return {
    threadId: row.threadId,
    version: row.version,
    contentHash: row.contentHash,
    source,
    basedOnEntryId: row.basedOnEntryId,
    estimatedTokens: row.estimatedTokens,
    createdAt: row.createdAt.toISOString(),
  }
}

export function mapCompactionRow(row: typeof platformThreadCompactions.$inferSelect): CompactionRecord {
  return compactionRecordSchema.parse({
    schemaVersion: 2,
    compactionId: row.compactionId,
    threadId: row.threadId,
    boundaryEntryId: row.boundaryEntryId,
    summaryEntryId: row.summaryEntryId,
    firstCompactedEntryId: row.firstCompactedEntryId,
    lastCompactedEntryId: row.lastCompactedEntryId,
    preservedFromEntryId: row.preservedFromEntryId,
    summary: row.summary,
    strategy: row.strategy,
    preTokens: row.preTokens,
    postTokens: row.postTokens,
    createdAt: row.createdAt.toISOString(),
  })
}
