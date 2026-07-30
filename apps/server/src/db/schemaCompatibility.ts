// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 数据库 Schema 兼容性检查
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
  '004_agents_sdk_native_runtime',
  '005_remove_public_sharing',
  '006_native_agent_runtime',
] as const

export const CURRENT_DATABASE_SCHEMA_VERSION = 6

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
      `数据库尚未启用版本跟踪。请按顺序应用 infra/migrations/004_agents_sdk_native_runtime.sql`
      + '、005_remove_public_sharing.sql 和 006_native_agent_runtime.sql 后重新启动。',
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
      `数据库升级未完成，缺少迁移：${missing.join('、')}。`
      + '请按编号顺序应用对应的 infra/migrations/*.sql，禁止跳过迁移或直接修改版本记录。',
    )
  }

  const unsupported = migrationIds
    .map(migrationId => ({ migrationId, version: migrationVersion(migrationId) }))
    .filter(entry => entry.version > CURRENT_DATABASE_SCHEMA_VERSION)
  if (unsupported.length > 0) {
    throw new Error(
      `数据库版本高于当前服务支持的 v${CURRENT_DATABASE_SCHEMA_VERSION}：`
      + `${unsupported.map(entry => entry.migrationId).join('、')}。请升级 GeoForge 服务，不能用旧服务连接新数据库。`,
    )
  }
}

function migrationVersion(migrationId: string): number {
  const match = /^(\d{3})_/u.exec(migrationId)
  return match ? Number.parseInt(match[1] ?? '', 10) : 0
}
