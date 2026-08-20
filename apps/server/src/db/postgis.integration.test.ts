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
import {
  agentStateSchema,
  replayRunDomainEvents,
  runDomainEventSchema,
} from '../schemas/types.js'
import { PostgresRunDomainJournalRepository } from '../store/postgres/runDomainJournalRepository.js'
import { RunDomainSequenceConflictError } from '../store/storeErrors.js'

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

  it('可重入迁移历史 Run 并从 sequence 1 完整重放领域快照', async () => {
    const sessionId = 'session_domain_backfill'
    const threadId = 'thread_domain_backfill'
    const runId = 'run_domain_backfill'
    const now = new Date('2026-08-20T00:00:00.000Z')
    const state = agentStateSchema.parse({
      sessionId,
      threadId,
      userQuery: '验证领域日志历史回放',
      objectiveRevision: 2,
    })

    try {
      await client.query(
        `INSERT INTO platform_sessions
           (session_id, visibility, status, created_at, updated_at)
         VALUES ($1, 'private', 'active', $2, $2)`,
        [sessionId, now],
      )
      await client.query(
        `INSERT INTO platform_threads
           (thread_id, session_id, visibility, title, next_entry_sequence, created_at, updated_at)
         VALUES ($1, $2, 'private', '领域日志迁移夹具', 3, $3, $3)`,
        [threadId, sessionId, now],
      )
      await client.query(
        `INSERT INTO platform_runs
           (run_id, session_id, thread_id, visibility, user_query, status, state_json,
            next_input_sequence, checkpoint_input_cursor, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', '验证领域日志历史回放', 'running', $4, 3, 1, $5, $5)`,
        [runId, sessionId, threadId, JSON.stringify(state), now],
      )
      await client.query(
        `INSERT INTO platform_conversation_entries
           (entry_id, session_id, thread_id, run_id, sequence, kind, payload_json, created_at)
         VALUES
           ('entry_domain_1', $1, $2, $3, 1, 'user_input', '{}'::jsonb, $4),
           ('entry_domain_2', $1, $2, $3, 2, 'user_input', '{}'::jsonb, $4)`,
        [sessionId, threadId, runId, now],
      )
      await client.query(
        `INSERT INTO platform_run_inputs
           (input_id, run_id, thread_id, entry_id, item_id, content, input_sequence,
            status, queued_at, lease_id, leased_at, acked_at)
         VALUES
           ('input_domain_1', $1, $2, 'entry_domain_1', 'item_domain_1', '第一条输入', 1,
            'acked', $3, 'lease_domain_1', $3, $3),
           ('input_domain_2', $1, $2, 'entry_domain_2', 'item_domain_2', '第二条输入', 2,
            'queued', $3, NULL, NULL, NULL)`,
        [runId, threadId, now],
      )

      await applyMigration(client, '013_run_domain_journal.sql')
      await applyMigration(client, '013_run_domain_journal.sql')

      const repository = new PostgresRunDomainJournalRepository(db)
      const events = await repository.listRunDomainEvents(runId)
      const snapshot = await repository.getRunDomainSnapshot(runId)

      expect(events.map(event => event.type)).toEqual([
        'run.created',
        'input.queued',
        'input.checkpointed',
        'run.checkpoint_changed',
      ])
      expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
      expect(replayRunDomainEvents(events)).toEqual(snapshot)
      expect(snapshot).toMatchObject({
        runId,
        sequence: 4,
        status: 'running',
        state: { objectiveRevision: 2 },
        inputDeliveries: {
          input_domain_1: { status: 'acked', leaseId: 'lease_domain_1' },
          input_domain_2: { status: 'queued', leaseId: null },
        },
        checkpoint: {
          nextInputSequence: 3,
          checkpointInputCursor: 1,
          activeInputLeaseId: null,
        },
      })

      const competingWrites = await Promise.allSettled([
        repository.appendRunDomainEvents({
          runId,
          expectedSequence: snapshot!.sequence,
          events: [migrationWarningEvent(runId, snapshot!.sequence + 1, 'writer_a')],
        }),
        repository.appendRunDomainEvents({
          runId,
          expectedSequence: snapshot!.sequence,
          events: [migrationWarningEvent(runId, snapshot!.sequence + 1, 'writer_b')],
        }),
      ])
      expect(competingWrites.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(competingWrites.find(result => result.status === 'rejected')).toMatchObject({
        reason: expect.any(RunDomainSequenceConflictError),
      })
      const finalEvents = await repository.listRunDomainEvents(runId)
      expect(finalEvents.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5])
      expect(replayRunDomainEvents(finalEvents)).toEqual(
        await repository.getRunDomainSnapshot(runId),
      )
    } finally {
      await client.query('DELETE FROM platform_sessions WHERE session_id = $1', [sessionId])
    }
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

async function applyMigration(client: Client, fileName: string): Promise<void> {
  const content = (await readFile(
    path.join(repositoryRoot, 'infra', 'migrations', fileName),
    'utf8',
  )).replace(/\r\n?/gu, '\n')
  await client.query(content)
}

function migrationWarningEvent(runId: string, sequence: number, suffix: string) {
  return runDomainEventSchema.parse({
    eventId: `domain_postgis_${suffix}`,
    runId,
    sequence,
    turnId: null,
    stepId: null,
    objectiveRevision: 2,
    causationId: null,
    correlationId: `domain_postgis_${suffix}`,
    actor: { kind: 'system', id: null },
    occurredAt: '2026-08-20T00:00:01.000Z',
    schemaVersion: 1,
    type: 'projection.warning',
    payload: { code: suffix, message: suffix },
  })
}
