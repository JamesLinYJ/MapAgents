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
      [{ migration_id: '001_init_postgis' }],
      [{ vector_tile_function: 'geo_agent_platform_layer_tiles(integer,integer,integer,json)' }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never)).resolves.toBeUndefined()
  })

  it('拒绝没有版本跟踪表的旧数据库并指向当前基线', async () => {
    const db = databaseWithRows([{ table_name: null }])

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/001_init_postgis/u)
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
      [
        { migration_id: '001_init_postgis' },
        { migration_id: '002_future_change' },
      ],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/数据库版本高于当前服务支持/u)
  })

  it('拒绝迁移记录存在但固定瓦片函数缺失的半升级数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [{ migration_id: '001_init_postgis' }],
      [{ vector_tile_function: null }],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/geo_agent_platform_layer_tiles\(integer, integer, integer, json\)/u)
  })
})
