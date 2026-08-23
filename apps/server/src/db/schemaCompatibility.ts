// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema 兼容性检查
//
//   文件:       schemaCompatibility.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { z } from 'zod'

import type { Database } from './connection.js'

export const REQUIRED_MIGRATIONS = [
  '000_schema_migrations',
  '001_init_postgis',
  '002_automation_reliability_constraints',
  '003_better_auth_admin',
  '004_agents_sdk_native_runtime',
  '005_remove_public_sharing',
  '006_native_agent_runtime',
  '007_model_result_cache',
  '008_tool_result_commit_idempotency',
  '009_file_object_lifecycle',
  '010_file_ready_source_invariant',
  '011_custom_model_providers',
  '012_run_input_delivery_ack',
  '013_run_domain_journal',
  '014_agent_step_geo_world',
] as const

export const CURRENT_DATABASE_SCHEMA_VERSION = 14

const migrationRowsSchema = z.array(z.object({
  migration_id: z.string().min(1),
  checksum: z.string().nullable().optional(),
}))

/**
 * 服务启动只验证数据库兼容性，不在运行时自动执行 DDL。
 * 缺失迁移和数据库版本过新都必须由部署者显式处理，避免半升级状态。
 */
export async function verifyDatabaseSchemaCompatibility(
  db: Pick<Database, 'execute'>,
): Promise<void> {
  const tableResult = await db.execute(sql`
    SELECT to_regclass('public.platform_schema_migrations') AS table_name
  `)
  const tableName = (tableResult.rows[0] as { table_name?: unknown } | undefined)?.table_name
  if (typeof tableName !== 'string') {
    throw new Error(
      '数据库尚未启用版本跟踪。请重建开发数据库并应用 '
      + 'infra/migrations/000_schema_migrations.sql 至 014_agent_step_geo_world.sql '
      + '后重新启动。',
    )
  }

  const migrationResult = await db.execute(sql`
    SELECT migration_id
      , checksum
    FROM platform_schema_migrations
    ORDER BY migration_id
  `)
  const migrationIds = migrationRowsSchema.parse(migrationResult.rows).map(row => row.migration_id)
  const applied = new Set(migrationIds)
  const missing = REQUIRED_MIGRATIONS.filter(migrationId => !applied.has(migrationId))
  if (missing.length > 0) {
    throw new Error(
      `数据库不是当前基线，缺少：${missing.join('、')}。`
      + '请先执行部署阶段 migration；禁止只补写版本记录。',
    )
  }

  const unverified = migrationResult.rows
    .map(row => migrationRowsSchema.element.parse(row))
    .filter(row => !row.checksum)
    .map(row => row.migration_id)
  if (unverified.length > 0) {
    throw new Error(
      `数据库存在没有 checksum 的 migration：${unverified.join('、')}。`
      + '请使用当前版本迁移器完成一次校准后再启动服务。',
    )
  }

  const unsupported = migrationIds
    .map(migrationId => ({ migrationId, version: migrationVersion(migrationId) }))
    .filter(entry => entry.version > CURRENT_DATABASE_SCHEMA_VERSION)
  if (unsupported.length > 0) {
    throw new Error(
      `数据库版本高于当前服务支持的 v${CURRENT_DATABASE_SCHEMA_VERSION}：`
      + `${unsupported.map(entry => entry.migrationId).join('、')}。请升级 平台 服务，不能用旧服务连接新数据库。`,
    )
  }

  const capabilityResult = await db.execute(sql`
    SELECT to_regprocedure(
      'public.geo_agent_platform_layer_tiles(integer,integer,integer,json)'
    ) AS vector_tile_function,
    to_regclass('public.platform_model_result_cache') AS model_result_cache_table,
    to_regclass('public.platform_file_objects') AS file_objects_table,
    to_regclass('public.platform_model_providers') AS model_providers_table,
    to_regclass('public.platform_run_domain_events') AS run_domain_events_table,
    to_regclass('public.platform_run_snapshots') AS run_snapshots_table,
    to_regclass('public.platform_geo_world_snapshots') AS geo_world_snapshots_table,
    to_regclass('public.platform_geo_world_diffs') AS geo_world_diffs_table,
    to_regclass('public.platform_agent_step_contexts') AS agent_step_contexts_table,
    COALESCE((
      SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
        = ARRAY['run_id', 'revision']::text[]
      FROM pg_constraint constraint_row
      CROSS JOIN LATERAL unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attnum
      WHERE constraint_row.conrelid = to_regclass('public.platform_geo_world_snapshots')
        AND constraint_row.contype = 'p'
      GROUP BY constraint_row.oid
    ), FALSE) AS geo_world_snapshot_primary_key,
    EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.platform_agent_step_contexts')
        AND conname = 'platform_agent_step_contexts_world_snapshot_fk'
        AND contype = 'f'
    ) AS agent_step_world_foreign_key,
    (
      SELECT COUNT(*) = 4
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_run_inputs'
        AND column_name IN ('input_sequence', 'lease_id', 'leased_at', 'acked_at')
    ) AND (
      SELECT COUNT(*) = 5
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runs'
        AND column_name IN (
          'next_input_sequence', 'checkpoint_input_cursor', 'active_input_lease_id',
          'active_input_lease_from', 'active_input_lease_to'
        )
    ) AS run_input_delivery_ack
  `)
  const vectorTileFunction = (
    capabilityResult.rows[0] as {
      vector_tile_function?: unknown
      model_result_cache_table?: unknown
      file_objects_table?: unknown
      model_providers_table?: unknown
      run_domain_events_table?: unknown
      run_snapshots_table?: unknown
      geo_world_snapshots_table?: unknown
      geo_world_diffs_table?: unknown
      agent_step_contexts_table?: unknown
      geo_world_snapshot_primary_key?: unknown
      agent_step_world_foreign_key?: unknown
      run_input_delivery_ack?: unknown
    } | undefined
  )?.vector_tile_function
  if (typeof vectorTileFunction !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：缺少 '
      + 'geo_agent_platform_layer_tiles(integer, integer, integer, json)。'
      + '请重新执行部署阶段 migration；'
      + '禁止只补写迁移记录。',
    )
  }
  const modelResultCacheTable = (
    capabilityResult.rows[0] as { model_result_cache_table?: unknown } | undefined
  )?.model_result_cache_table
  if (typeof modelResultCacheTable !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：缺少 platform_model_result_cache。'
      + '请执行 007_model_result_cache.sql；禁止由应用启动时创建业务表。',
    )
  }
  const fileObjectsTable = (
    capabilityResult.rows[0] as { file_objects_table?: unknown } | undefined
  )?.file_objects_table
  if (typeof fileObjectsTable !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：缺少 platform_file_objects。'
      + '请执行 009_file_object_lifecycle.sql；禁止由应用启动时创建业务表。',
    )
  }
  const modelProvidersTable = (
    capabilityResult.rows[0] as { model_providers_table?: unknown } | undefined
  )?.model_providers_table
  if (typeof modelProvidersTable !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：缺少 platform_model_providers。'
      + '请执行 011_custom_model_providers.sql；禁止由应用启动时创建业务表。',
    )
  }
  const runInputDeliveryAck = (
    capabilityResult.rows[0] as { run_input_delivery_ack?: unknown } | undefined
  )?.run_input_delivery_ack
  if (runInputDeliveryAck !== true) {
    throw new Error(
      '数据库迁移记录与实际能力不一致：Run input sequence/cursor/lease 列不完整。'
      + '请执行 012_run_input_delivery_ack.sql；禁止只补写迁移记录。',
    )
  }
  const runDomainEventsTable = (
    capabilityResult.rows[0] as { run_domain_events_table?: unknown } | undefined
  )?.run_domain_events_table
  const runSnapshotsTable = (
    capabilityResult.rows[0] as { run_snapshots_table?: unknown } | undefined
  )?.run_snapshots_table
  if (typeof runDomainEventsTable !== 'string' || typeof runSnapshotsTable !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：Run domain journal/snapshot 表不完整。'
      + '请执行 013_run_domain_journal.sql；禁止只补写迁移记录。',
    )
  }
  const geoWorldSnapshotsTable = (
    capabilityResult.rows[0] as { geo_world_snapshots_table?: unknown } | undefined
  )?.geo_world_snapshots_table
  const geoWorldDiffsTable = (
    capabilityResult.rows[0] as { geo_world_diffs_table?: unknown } | undefined
  )?.geo_world_diffs_table
  const agentStepContextsTable = (
    capabilityResult.rows[0] as { agent_step_contexts_table?: unknown } | undefined
  )?.agent_step_contexts_table
  const geoWorldSnapshotPrimaryKey = (
    capabilityResult.rows[0] as { geo_world_snapshot_primary_key?: unknown } | undefined
  )?.geo_world_snapshot_primary_key
  const agentStepWorldForeignKey = (
    capabilityResult.rows[0] as { agent_step_world_foreign_key?: unknown } | undefined
  )?.agent_step_world_foreign_key
  if (
    typeof geoWorldSnapshotsTable !== 'string'
    || typeof geoWorldDiffsTable !== 'string'
    || typeof agentStepContextsTable !== 'string'
    || geoWorldSnapshotPrimaryKey !== true
    || agentStepWorldForeignKey !== true
  ) {
    throw new Error(
      '数据库迁移记录与实际能力不一致：GeoWorld/Agent StepContext 表或追加式主键不完整。'
      + '请执行 014_agent_step_geo_world.sql；禁止只补写迁移记录。',
    )
  }
}

function migrationVersion(migrationId: string): number {
  const match = /^(\d{3})_/u.exec(migrationId)
  return match ? Number.parseInt(match[1] ?? '', 10) : 0
}
