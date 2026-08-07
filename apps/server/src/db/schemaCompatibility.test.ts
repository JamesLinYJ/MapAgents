// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema 兼容性检查测试
//
//   文件:       schemaCompatibility.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { verifyDatabaseSchemaCompatibility } from './schemaCompatibility.js'

const migrationIds = [
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
] as const

function currentMigrations() {
  return migrationIds.map(migration_id => ({ migration_id, checksum: 'a'.repeat(64) }))
}

function databaseWithRows(...rows: unknown[][]) {
  return {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: rows[0] ?? [] })
      .mockResolvedValueOnce({ rows: rows[1] ?? [] })
      .mockResolvedValueOnce({ rows: rows[2] ?? [] }),
  }
}

describe('verifyDatabaseSchemaCompatibility', () => {
  it('接受当前单一基线', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      currentMigrations(),
      [{
        vector_tile_function: 'geo_agent_platform_layer_tiles(integer,integer,integer,json)',
        model_result_cache_table: 'platform_model_result_cache',
        file_objects_table: 'platform_file_objects',
      }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never)).resolves.toBeUndefined()
  })

  it('拒绝没有版本跟踪表的旧数据库并指向当前基线', async () => {
    const db = databaseWithRows([{ table_name: null }])

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/000_schema_migrations/u)
  })

  it('拒绝没有当前基线记录的数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/001_init_postgis/u)
  })

  it('拒绝让旧服务连接未来版本数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [...currentMigrations(), { migration_id: '011_future_change', checksum: 'b'.repeat(64) }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/数据库版本高于当前服务支持/u)
  })

  it('拒绝迁移记录存在但固定瓦片函数缺失的半升级数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      currentMigrations(),
      [{ vector_tile_function: null, model_result_cache_table: 'platform_model_result_cache', file_objects_table: 'platform_file_objects' }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/geo_agent_platform_layer_tiles\(integer, integer, integer, json\)/u)
  })

  it('拒绝没有 checksum 的遗留迁移记录', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      currentMigrations().map(row => row.migration_id === '001_init_postgis'
        ? { migration_id: row.migration_id, checksum: null }
        : row),
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/没有 checksum/u)
  })

  it('拒绝缓存表缺失的半升级数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      currentMigrations(),
      [{
        vector_tile_function: 'geo_agent_platform_layer_tiles(integer,integer,integer,json)',
        model_result_cache_table: null,
        file_objects_table: 'platform_file_objects',
      }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/platform_model_result_cache/u)
  })
})
