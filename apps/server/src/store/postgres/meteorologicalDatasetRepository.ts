// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 气象数据集仓储
//
//   文件:       meteorologicalDatasetRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { and, desc, eq, sql, type SQL } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformMeteorologicalDatasets } from '../../db/schema.js'
import type { MeteorologicalDatasetRecord } from '../../schemas/types.js'
import { decodeRequiredRecord, decodeRequiredTimestamp } from '../../db/valueDecoders.js'

type DatasetRow = typeof platformMeteorologicalDatasets.$inferSelect

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

/** 上传气象数据集元数据、作用域与文件引用的唯一写入边界。 */
export class MeteorologicalDatasetRepository {
  constructor(private readonly db: Database) {}

  async list(filters: ListMeteorologicalDatasetsFilters = {}): Promise<MeteorologicalDatasetRecord[]> {
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 500))
    const conditions = buildConditions(filters)
    const query = this.db
      .select()
      .from(platformMeteorologicalDatasets)
      .orderBy(desc(platformMeteorologicalDatasets.updatedAt))
      .limit(limit)
    const rows = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query
    return rows.map(mapDatasetRow)
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
      const row = rows[0]
      return row ? mapDatasetRow(row) : null
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
    const row = rows[0]
    return row ? mapDatasetRow(row) : null
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
}

function buildConditions(filters: ListMeteorologicalDatasetsFilters): SQL[] {
  const conditions: SQL[] = []
  if (filters.workspaceId) conditions.push(eq(platformMeteorologicalDatasets.workspaceId, filters.workspaceId))
  if (filters.sessionId) conditions.push(eq(platformMeteorologicalDatasets.sessionId, filters.sessionId))
  if (filters.threadId) conditions.push(eq(platformMeteorologicalDatasets.threadId, filters.threadId))
  if (filters.filename) {
    conditions.push(sql`lower(${platformMeteorologicalDatasets.filename}) = lower(${filters.filename})`)
  }
  return conditions
}

function mapDatasetRow(row: DatasetRow): MeteorologicalDatasetRecord {
  return {
    datasetId: row.datasetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: decodeVisibility(row.visibility),
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
    metadata: decodeRequiredRecord(row.metadataJson, 'platform_meteorological_datasets.metadata_json'),
    createdAt: decodeRequiredTimestamp(row.createdAt, 'platform_meteorological_datasets.created_at'),
    updatedAt: decodeRequiredTimestamp(row.updatedAt, 'platform_meteorological_datasets.updated_at'),
  }
}

function decodeVisibility(value: string): MeteorologicalDatasetRecord['visibility'] {
  if (value === 'private' || value === 'workspace' || value === 'public') return value
  throw new Error(`platform_meteorological_datasets.visibility 值 '${value}' 无效。`)
}
