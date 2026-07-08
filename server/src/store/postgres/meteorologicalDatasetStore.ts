// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据集索引存储
//
//   文件:       meteorologicalDatasetStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { platformMeteorologicalDatasets, platformMeteorologicalJobs } from '../../db/schema.js'
import type { MeteorologicalDatasetRecord, MeteorologicalJobRecord } from '../../schemas/types.js'
import { isRecord, toIsoString } from '../platformStoreUtils.js'

type DatasetRow = typeof platformMeteorologicalDatasets.$inferSelect
type JobRow = typeof platformMeteorologicalJobs.$inferSelect

export interface ListMeteorologicalDatasetsFilters {
  sessionId?: string | null
  threadId?: string | null
  filename?: string | null
  workspaceId?: string | null
  limit?: number
}

export interface ResolveMeteorologicalDatasetFilters {
  sessionId: string
  threadId?: string | null
  datasetId?: string | null
  filename?: string | null
  workspaceId?: string | null
}

// 气象数据集表是上传文件与工具运行之间的资源索引。所有 scope 条件都在
// 数据库查询中表达，不允许先全量读取再在 Node 进程里过滤工作区。
export class MeteorologicalDatasetStore {
  constructor(private readonly db: Database) {}

  async list(filters: ListMeteorologicalDatasetsFilters = {}): Promise<MeteorologicalDatasetRecord[]> {
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 500))
    const conditions = this.buildConditions(filters)
    const rows = conditions.length > 0
      ? await this.db
        .select()
        .from(platformMeteorologicalDatasets)
        .where(and(...conditions))
        .orderBy(desc(platformMeteorologicalDatasets.updatedAt))
        .limit(limit)
      : await this.db
        .select()
        .from(platformMeteorologicalDatasets)
        .orderBy(desc(platformMeteorologicalDatasets.updatedAt))
        .limit(limit)
    return rows.map(row => mapDatasetRow(row))
  }

  async resolve(filters: ResolveMeteorologicalDatasetFilters): Promise<MeteorologicalDatasetRecord | null> {
    const explicitDatasetId = filters.datasetId?.trim()
    if (explicitDatasetId && explicitDatasetId !== 'latest_upload') {
      const conditions: SQL[] = [eq(platformMeteorologicalDatasets.datasetId, explicitDatasetId)]
      if (filters.workspaceId) {
        conditions.push(eq(platformMeteorologicalDatasets.workspaceId, filters.workspaceId))
      }
      const rows = await this.db
        .select()
        .from(platformMeteorologicalDatasets)
        .where(and(...conditions))
        .limit(1)
      return rows[0] ? mapDatasetRow(rows[0]) : null
    }

    const matches = await this.list({
      sessionId: filters.sessionId,
      threadId: filters.threadId ?? null,
      filename: filters.filename ?? null,
      workspaceId: filters.workspaceId ?? null,
      limit: 1,
    })
    return matches[0] ?? null
  }

  async get(datasetId: string): Promise<MeteorologicalDatasetRecord | null> {
    const rows = await this.db
      .select()
      .from(platformMeteorologicalDatasets)
      .where(eq(platformMeteorologicalDatasets.datasetId, datasetId))
      .limit(1)
    return rows[0] ? mapDatasetRow(rows[0]) : null
  }

  async create(dataset: MeteorologicalDatasetRecord): Promise<void> {
    await this.db.insert(platformMeteorologicalDatasets).values({
      datasetId: dataset.datasetId,
      workspaceId: dataset.workspaceId,
      createdByUserId: dataset.createdByUserId,
      visibility: dataset.visibility,
      sessionId: dataset.sessionId,
      threadId: dataset.threadId,
      filename: dataset.filename,
      originalFilename: dataset.originalFilename,
      fileId: dataset.fileId,
      fileRelativePath: dataset.fileRelativePath,
      sizeBytes: dataset.sizeBytes,
      contentHash: dataset.contentHash,
      mediaType: dataset.mediaType,
      status: dataset.status,
      metadataJson: dataset.metadata,
      createdAt: new Date(dataset.createdAt),
      updatedAt: new Date(dataset.updatedAt),
    })
  }

  async getJob(jobId: string): Promise<MeteorologicalJobRecord | null> {
    const rows = await this.db
      .select()
      .from(platformMeteorologicalJobs)
      .where(eq(platformMeteorologicalJobs.jobId, jobId))
      .limit(1)
    return rows[0] ? mapJobRow(rows[0]) : null
  }

  async createJob(job: MeteorologicalJobRecord): Promise<void> {
    await this.db.insert(platformMeteorologicalJobs).values({
      jobId: job.jobId,
      datasetId: job.datasetId,
      workspaceId: job.workspaceId,
      createdByUserId: job.createdByUserId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      kind: job.kind,
      status: job.status,
      message: job.message,
      payloadJson: job.payload,
      createdAt: new Date(job.createdAt),
      updatedAt: new Date(job.updatedAt),
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
    })
  }

  private buildConditions(filters: ListMeteorologicalDatasetsFilters): SQL[] {
    const conditions: SQL[] = []
    if (filters.workspaceId) conditions.push(eq(platformMeteorologicalDatasets.workspaceId, filters.workspaceId))
    if (filters.sessionId) conditions.push(eq(platformMeteorologicalDatasets.sessionId, filters.sessionId))
    if (filters.threadId) conditions.push(eq(platformMeteorologicalDatasets.threadId, filters.threadId))
    if (filters.filename) {
      conditions.push(sql`lower(${platformMeteorologicalDatasets.filename}) = lower(${filters.filename})`)
    }
    return conditions
  }
}

function mapDatasetRow(row: DatasetRow): MeteorologicalDatasetRecord {
  return {
    datasetId: row.datasetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: normalizeVisibility(row.visibility),
    sessionId: row.sessionId,
    threadId: row.threadId,
    filename: row.filename,
    originalFilename: row.originalFilename,
    fileId: row.fileId,
    fileRelativePath: row.fileRelativePath,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    mediaType: row.mediaType,
    status: row.status,
    metadata: isRecord(row.metadataJson) ? row.metadataJson : {},
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}

function normalizeVisibility(value: string): MeteorologicalDatasetRecord['visibility'] {
  return value === 'private' || value === 'public' ? value : 'workspace'
}

function mapJobRow(row: JobRow): MeteorologicalJobRecord {
  return {
    jobId: row.jobId,
    datasetId: row.datasetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    sessionId: row.sessionId,
    threadId: row.threadId,
    kind: row.kind,
    status: row.status,
    message: row.message,
    payload: isRecord(row.payloadJson) ? row.payloadJson : {},
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
  }
}
