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

import type { Database } from './connection.js'

export const DATABASE_SCHEMA_CONTRACT_VERSION = 1

/**
 * 服务启动只验证数据库结构能力，不在运行时自动执行 DDL。
 * 新数据库由 infra/database/schema.sql 一次初始化；旧结构必须显式导出后重建。
 */
export async function verifyDatabaseSchemaCompatibility(
  db: Pick<Database, 'execute'>,
): Promise<void> {
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
    to_regclass('public.platform_model_request_records') AS model_request_records_table,
    to_regclass('public.platform_tool_invocations') AS tool_invocations_table,
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
      SELECT COUNT(*) = 6
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_run_inputs'
        AND column_name IN (
          'input_sequence', 'lease_id', 'leased_at',
          'model_request_id', 'included_at', 'checkpointed_at'
        )
    ) AND (
      SELECT COUNT(*) = 9
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runs'
        AND column_name IN (
          'next_input_sequence', 'checkpoint_input_cursor', 'active_input_lease_id',
          'active_input_lease_from', 'active_input_lease_to',
          'terminal_input_claim_id', 'terminal_objective_revision',
          'terminal_input_cursor', 'terminal_claimed_at'
        )
    ) AS run_input_mailbox
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
      model_request_records_table?: unknown
      tool_invocations_table?: unknown
      geo_world_snapshot_primary_key?: unknown
      agent_step_world_foreign_key?: unknown
      run_input_mailbox?: unknown
    } | undefined
  )?.vector_tile_function
  if (typeof vectorTileFunction !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 '
      + 'geo_agent_platform_layer_tiles(integer, integer, integer, json)。'
      + '请使用空数据库执行 infra/database/schema.sql。',
    )
  }
  const modelResultCacheTable = (
    capabilityResult.rows[0] as { model_result_cache_table?: unknown } | undefined
  )?.model_result_cache_table
  if (typeof modelResultCacheTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_model_result_cache。'
      + '请使用空数据库执行 infra/database/schema.sql。',
    )
  }
  const fileObjectsTable = (
    capabilityResult.rows[0] as { file_objects_table?: unknown } | undefined
  )?.file_objects_table
  if (typeof fileObjectsTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_file_objects。'
      + '请使用空数据库执行 infra/database/schema.sql。',
    )
  }
  const modelProvidersTable = (
    capabilityResult.rows[0] as { model_providers_table?: unknown } | undefined
  )?.model_providers_table
  if (typeof modelProvidersTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_model_providers。'
      + '请使用空数据库执行 infra/database/schema.sql。',
    )
  }
  const runInputMailbox = (
    capabilityResult.rows[0] as { run_input_mailbox?: unknown } | undefined
  )?.run_input_mailbox
  if (runInputMailbox !== true) {
    throw new Error(
      '数据库结构与当前应用契约不一致：Run input mailbox/model-request/terminal claim 列不完整。'
      + '请使用空数据库执行 infra/database/schema.sql。',
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
      '数据库结构与当前应用契约不一致：Run domain journal/snapshot 表不完整。'
      + '请使用空数据库执行 infra/database/schema.sql。',
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
  const modelRequestRecordsTable = (
    capabilityResult.rows[0] as { model_request_records_table?: unknown } | undefined
  )?.model_request_records_table
  const toolInvocationsTable = (
    capabilityResult.rows[0] as { tool_invocations_table?: unknown } | undefined
  )?.tool_invocations_table
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
    || typeof modelRequestRecordsTable !== 'string'
    || typeof toolInvocationsTable !== 'string'
    || geoWorldSnapshotPrimaryKey !== true
    || agentStepWorldForeignKey !== true
  ) {
    throw new Error(
      '数据库结构与当前应用契约不一致：GeoWorld/Agent StepContext/ModelRequest/ToolInvocation 表或追加式主键不完整。'
      + '请使用空数据库执行 infra/database/schema.sql。',
    )
  }
}
