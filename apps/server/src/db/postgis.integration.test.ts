// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 真实集成回归
//
//   该文件默认不启动容器；通过 `npm run test:postgis` 显式运行。
//   单元测试不应隐式依赖 Docker，集成测试则必须连接真实 PostGIS。
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, type Database } from './connection.js'
import { verifyDatabaseSchemaCompatibility } from './schemaCompatibility.js'
import { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'

const integrationEnabled = process.env.RUN_POSTGIS_INTEGRATION === '1'
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe.skipIf(!integrationEnabled)('真实 PostgreSQL/PostGIS 集成', () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let db: Database

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.5')
      .withDatabase('geo_agent_integration')
      .withUsername('geo_agent')
      .withPassword('integration-only-password')
      .start()

    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await applyMigrations(client)

    db = createDb(container.getConnectionUri())
    await verifyDatabaseSchemaCompatibility(db)
  }, 180_000)

  afterAll(async () => {
    await db?.close()
    await client?.end()
    await container?.stop()
  }, 30_000)

  it('应用全部迁移并验证 PostGIS 能力', async () => {
    const result = await db.execute<{ version: string }>(sql`
      SELECT postgis_full_version() AS version
    `)
    expect(result.rows[0]?.version).toMatch(/POSTGIS/u)
  })

  it('通过真实空间表完成图层导入、筛选、计数和删除', async () => {
    const service = new ManagedLayerService(db)
    const layer = await service.importGeoJsonLayer({
      layerKey: 'postgis_integration_points',
      name: 'PostGIS 集成点',
      sourceType: 'system',
      collection: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [120.1, 30.2] },
            properties: { category: 'alpha', value: 1 },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [120.2, 30.3] },
            properties: { category: 'beta', value: 2 },
          },
        ],
      },
    })

    expect(layer.layerKey).toBe('postgis_integration_points')
    expect(await service.featureCount(layer.layerKey)).toBe(2)
    expect(await service.featureCount(layer.layerKey, {
      propertyFilter: { property: 'category', values: ['beta'] },
    })).toBe(1)
    const features = await service.queryFeatures(layer.layerKey, { limit: 2 })
    expect(features).toHaveLength(2)
    expect(features[0]?.geometry.type).toBe('Point')

    expect(await service.deleteLayer(layer.layerKey)).toBe(true)
    expect(await service.getLayer(layer.layerKey)).toBeNull()
  })
})

async function applyMigrations(client: Client): Promise<void> {
  const directory = path.join(repositoryRoot, 'infra', 'migrations')
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^\d{3}_[a-z0-9_]+\.sql$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of files) {
    const content = (await readFile(path.join(directory, entry.name), 'utf8')).replace(/\r\n?/gu, '\n')
    await client.query(content)
    const migrationId = entry.name.replace(/\.sql$/u, '')
    const checksum = createHash('sha256').update(content).digest('hex')
    await client.query(`
      INSERT INTO platform_schema_migrations
        (migration_id, checksum, application_release)
      VALUES ($1, $2, $3)
      ON CONFLICT (migration_id) DO UPDATE SET
        checksum = EXCLUDED.checksum,
        application_release = EXCLUDED.application_release
    `, [migrationId, checksum, 'postgis-integration-test'])
  }
}
