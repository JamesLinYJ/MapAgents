// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 托管图层要素仓储
//
//   文件:       managedFeatureRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { count, eq, sql } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'
import { platformLayerFeatures } from '../../db/schema.js'
import type { GeoJsonFeature } from '../geojson.js'
import { parseGeoJsonEntity, requireSingleFeature } from '../geojson.js'
import type { LayerBounds, StoredFeature } from './managedLayerTypes.js'

interface StoredFeatureRow extends Record<string, unknown> {
  geometry: unknown
  properties: unknown
}

/** 托管图层空间要素的替换、查询和计数边界。 */
export class ManagedFeatureRepository {
  constructor(private readonly db: Database) {}

  async queryFeatures(mapLayerId: string, bbox?: LayerBounds, limit = 100): Promise<StoredFeature[]> {
    const safeLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)))
    // ST_AsGeoJSON 与 bbox 运算是 PostGIS 专用能力，集中在本仓储的审计过 raw SQL 中。
    const result = bbox
      ? await this.db.execute<StoredFeatureRow>(sql`
          SELECT ST_AsGeoJSON(geometry)::jsonb AS geometry, properties_json AS properties
          FROM platform_layer_features
          WHERE map_layer_id = ${mapLayerId}
            AND geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)
          ORDER BY feature_id
          LIMIT ${safeLimit}
        `)
      : await this.db.execute<StoredFeatureRow>(sql`
          SELECT ST_AsGeoJSON(geometry)::jsonb AS geometry, properties_json AS properties
          FROM platform_layer_features
          WHERE map_layer_id = ${mapLayerId}
          ORDER BY feature_id
          LIMIT ${safeLimit}
        `)
    return result.rows.map(mapRowToFeature)
  }

  async featureCount(mapLayerId: string): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(platformLayerFeatures)
      .where(eq(platformLayerFeatures.mapLayerId, mapLayerId))
    return Number(rows[0]?.value ?? 0)
  }

  async replaceFeatures(
    tx: DatabaseTransaction,
    mapLayerId: string,
    features: GeoJsonFeature[],
    now: Date,
  ): Promise<void> {
    await tx.delete(platformLayerFeatures).where(eq(platformLayerFeatures.mapLayerId, mapLayerId))
    for (let offset = 0; offset < features.length; offset += 250) {
      const batch = features.slice(offset, offset + 250)
      const values = batch.map((feature, index) => sql`(
        ${mapLayerId},
        ${`feature_${offset + index + 1}`},
        ${JSON.stringify(feature.properties ?? {})}::jsonb,
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(feature.geometry)}), 4326),
        ${now},
        ${now}
      )`)
      // PostGIS geometry 构造无法用普通 query builder 表达；参数仍由 Drizzle 绑定，禁止拼接 SQL 文本。
      await tx.execute(sql`
        INSERT INTO platform_layer_features (
          map_layer_id, feature_id, properties_json, geometry, created_at, updated_at
        ) VALUES ${sql.join(values, sql`, `)}
      `)
    }
  }
}

function mapRowToFeature(row: StoredFeatureRow): StoredFeature {
  const geometryEntity = parseGeoJsonEntity(row.geometry, 'PostGIS geometry')
  return {
    geometry: requireSingleFeature(geometryEntity, 'PostGIS geometry').geometry,
    properties: decodeRequiredRecord(row.properties, 'platform_layer_features.properties_json'),
  }
}
