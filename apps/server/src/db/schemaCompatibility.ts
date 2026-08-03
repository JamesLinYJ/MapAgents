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

const REQUIRED_MIGRATIONS = [
  '001_init_postgis',
] as const

export const CURRENT_DATABASE_SCHEMA_VERSION = 1

const migrationRowsSchema = z.array(z.object({
  migration_id: z.string().min(1),
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
      + 'infra/migrations/001_init_postgis.sql 后重新启动。',
    )
  }

  const migrationResult = await db.execute(sql`
    SELECT migration_id
    FROM platform_schema_migrations
    ORDER BY migration_id
  `)
  const migrationIds = migrationRowsSchema.parse(migrationResult.rows).map(row => row.migration_id)
  const applied = new Set(migrationIds)
  const missing = REQUIRED_MIGRATIONS.filter(migrationId => !applied.has(migrationId))
  if (missing.length > 0) {
    throw new Error(
      `数据库不是当前基线，缺少：${missing.join('、')}。`
      + '请重建开发数据库；禁止只补写版本记录。',
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
    ) AS vector_tile_function
  `)
  const vectorTileFunction = (
    capabilityResult.rows[0] as { vector_tile_function?: unknown } | undefined
  )?.vector_tile_function
  if (typeof vectorTileFunction !== 'string') {
    throw new Error(
      '数据库迁移记录与实际能力不一致：缺少 '
      + 'geo_agent_platform_layer_tiles(integer, integer, integer, json)。'
      + '请重建数据库并重新应用 infra/migrations/001_init_postgis.sql；'
      + '禁止只补写迁移记录。',
    )
  }
}

function migrationVersion(migrationId: string): number {
  const match = /^(\d{3})_/u.exec(migrationId)
  return match ? Number.parseInt(match[1] ?? '', 10) : 0
}
