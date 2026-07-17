// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 托管图层元数据仓储
//
//   文件:       managedLayerRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformMapLayers } from '../../db/schema.js'
import {
  layerDescriptorSchema,
  layerPropertyDescriptorSchema,
  resourceVisibilitySchema,
  type LayerDescriptor,
} from '../../schemas/types.js'
import type {
  LayerMetadataPatch,
  PreparedManagedLayerImport,
} from './managedLayerTypes.js'

/** 托管图层元数据、归属和能力描述的唯一写入边界。 */
export class ManagedLayerRepository {
  constructor(private readonly db: Database) {}

  async listVisibleLayers(
    workspaceId: string,
    sessionId?: string | null,
    threadId?: string | null,
  ): Promise<LayerDescriptor[]> {
    const ownership = or(
      eq(platformMapLayers.ownershipScope, 'system'),
      eq(platformMapLayers.workspaceId, workspaceId),
    )
    const location = threadId
      ? or(
          eq(platformMapLayers.ownershipScope, 'system'),
          eq(platformMapLayers.threadId, threadId),
          and(eq(platformMapLayers.ownershipScope, 'workspace'), eq(platformMapLayers.workspaceId, workspaceId)),
          ...(sessionId ? [eq(platformMapLayers.sessionId, sessionId)] : []),
        )
      : sessionId
        ? or(
            eq(platformMapLayers.ownershipScope, 'system'),
            and(eq(platformMapLayers.ownershipScope, 'workspace'), eq(platformMapLayers.workspaceId, workspaceId)),
            eq(platformMapLayers.sessionId, sessionId),
          )
        : ownership
    const rows = await this.db.select().from(platformMapLayers)
      .where(and(
        isNull(platformMapLayers.artifactId),
        ownership,
        location,
      ))
      .orderBy(desc(platformMapLayers.updatedAt))
    return rows.map(mapRowToLayerDescriptor)
  }

  async getLayer(layerKey: string): Promise<LayerDescriptor | null> {
    const rows = await this.db.select().from(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey)).limit(1)
    const row = rows[0]
    return row ? mapRowToLayerDescriptor(row) : null
  }

  async geocode(query: string): Promise<Array<{ label: string; longitude: number; latitude: number }>> {
    const rows = await this.db.select({
      name: platformMapLayers.title,
      bounds: platformMapLayers.boundsJson,
    }).from(platformMapLayers)
      .where(and(
        isNull(platformMapLayers.artifactId),
        ilike(platformMapLayers.title, `%${query}%`),
      ))
      .limit(10)
    return rows.map(row => ({
      label: row.name,
      longitude: (row.bounds[0] + row.bounds[2]) / 2,
      latitude: (row.bounds[1] + row.bounds[3]) / 2,
    }))
  }

  async upsertImportedLayer(
    tx: DatabaseTransaction,
    prepared: PreparedManagedLayerImport,
    now: Date,
  ): Promise<void> {
    const { input, ownership } = prepared
    await tx.insert(platformMapLayers).values({
      mapLayerId: prepared.mapLayerId,
      ownershipScope: ownership.scope,
      workspaceId: ownership.workspaceId,
      threadId: ownership.threadId,
      artifactId: null,
      managedLayerKey: prepared.layerKey,
      title: input.name,
      sourceType: input.sourceType,
      geometryType: prepared.geometryType,
      srid: 4326,
      description: input.description ?? '',
      featureCount: prepared.features.length,
      propertySchemaJson: prepared.propertySchema,
      category: input.category ?? 'upload',
      tagsJson: input.tags ?? [],
      analysisCapabilitiesJson: ['query', 'spatial_analysis'],
      sourceConfigSummary: input.sourceFilename ?? null,
      sessionId: input.sessionId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      visibility: input.visibility ?? 'workspace',
      readonly: input.readonly === true || input.sourceType === 'system',
      status: input.status === 'disabled' ? 'disabled' : 'ready',
      errorMessage: null,
      boundsJson: prepared.bounds,
      crs: 'EPSG:4326',
      minZoom: 0,
      maxZoom: 22,
      sourceJson: {
        kind: 'vector_tiles',
        tileJsonUrl: `/api/v1/map/layers/${prepared.mapLayerId}/tilejson`,
        sourceLayer: 'features',
      },
      styleJson: prepared.style,
      legendJson: null,
      temporalJson: null,
      capabilitiesJson: {
        query: true,
        labels: prepared.propertySchema.length > 0,
        style: true,
        temporal: false,
        opacity: true,
        download: true,
      },
      dataVersion: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: platformMapLayers.managedLayerKey,
      set: {
        ownershipScope: ownership.scope,
        workspaceId: ownership.workspaceId,
        threadId: ownership.threadId,
        title: input.name,
        sourceType: input.sourceType,
        geometryType: prepared.geometryType,
        description: input.description ?? '',
        featureCount: prepared.features.length,
        propertySchemaJson: prepared.propertySchema,
        category: input.category ?? 'upload',
        tagsJson: input.tags ?? [],
        sourceConfigSummary: input.sourceFilename ?? null,
        sessionId: input.sessionId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        visibility: input.visibility ?? 'workspace',
        readonly: input.readonly === true || input.sourceType === 'system',
        status: input.status === 'disabled' ? 'disabled' : 'ready',
        boundsJson: prepared.bounds,
        styleJson: prepared.style,
        dataVersion: sql`${platformMapLayers.dataVersion} + 1`,
        updatedAt: now,
      },
    })
  }

  async updateLayerMetadata(layerKey: string, patch: LayerMetadataPatch): Promise<LayerDescriptor> {
    const layer = await this.getLayer(layerKey)
    if (!layer) throw new Error(`图层 '${layerKey}' 不存在`)
    await this.db.update(platformMapLayers).set({
      title: patch.name ?? layer.name,
      description: patch.description ?? layer.description,
      tagsJson: patch.tags ?? layer.tags,
      category: patch.category ?? layer.category,
      status: patch.status === 'disabled' ? 'disabled' : 'ready',
      analysisCapabilitiesJson: patch.analysisCapabilities ?? layer.analysisCapabilities,
      sourceConfigSummary: patch.sourceConfigSummary === undefined
        ? layer.sourceConfigSummary
        : patch.sourceConfigSummary,
      updatedAt: new Date(),
    }).where(eq(platformMapLayers.managedLayerKey, layerKey))
    const updated = await this.getLayer(layerKey)
    if (!updated) throw new Error(`图层 '${layerKey}' 更新后无法读取`)
    return updated
  }

  async deleteLayer(layerKey: string): Promise<boolean> {
    const deleted = await this.db.delete(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey))
      .returning({ mapLayerId: platformMapLayers.mapLayerId })
    return deleted.length > 0
  }

  async requireManagedMapLayerId(layerKey: string): Promise<string> {
    const rows = await this.db.select({ mapLayerId: platformMapLayers.mapLayerId })
      .from(platformMapLayers)
      .where(eq(platformMapLayers.managedLayerKey, layerKey)).limit(1)
    const mapLayerId = rows[0]?.mapLayerId
    if (!mapLayerId) throw new Error(`图层 '${layerKey}' 不存在`)
    return mapLayerId
  }
}

function mapRowToLayerDescriptor(row: typeof platformMapLayers.$inferSelect): LayerDescriptor {
  return layerDescriptorSchema.parse({
    mapLayerId: row.mapLayerId,
    layerKey: row.managedLayerKey ?? row.mapLayerId,
    name: row.title,
    sourceType: row.sourceType,
    geometryType: row.geometryType,
    srid: row.srid,
    description: row.description,
    featureCount: row.featureCount,
    bounds: row.boundsJson,
    propertySchema: layerPropertyDescriptorSchema.array().parse(row.propertySchemaJson),
    category: row.category,
    status: row.status === 'ready' ? 'active' : row.status,
    tags: row.tagsJson,
    analysisCapabilities: row.analysisCapabilitiesJson,
    sourceConfigSummary: row.sourceConfigSummary,
    sessionId: row.sessionId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: resourceVisibilitySchema.parse(row.visibility),
    readonly: row.readonly,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
