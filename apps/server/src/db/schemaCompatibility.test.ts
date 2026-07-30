// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 数据库 Schema 兼容性检查测试
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
      .mockResolvedValueOnce({ rows: rows[1] ?? [] }),
  }
}

describe('verifyDatabaseSchemaCompatibility', () => {
  it('接受完整且受支持的迁移链', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [
        { migration_id: '004_agents_sdk_native_runtime' },
        { migration_id: '005_remove_public_sharing' },
        { migration_id: '006_native_agent_runtime' },
      ],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never)).resolves.toBeUndefined()
  })

  it('拒绝没有版本跟踪表的旧数据库并给出迁移顺序', async () => {
    const db = databaseWithRows([{ table_name: null }])

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/004_agents_sdk_native_runtime.*005_remove_public_sharing.*006_native_agent_runtime/u)
  })

  it('拒绝缺失的中间迁移', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [
        { migration_id: '004_agents_sdk_native_runtime' },
        { migration_id: '006_native_agent_runtime' },
      ],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/005_remove_public_sharing/u)
  })

  it('拒绝让旧服务连接未来版本数据库', async () => {
    const db = databaseWithRows(
      [{ table_name: 'platform_schema_migrations' }],
      [
        { migration_id: '004_agents_sdk_native_runtime' },
        { migration_id: '005_remove_public_sharing' },
        { migration_id: '006_native_agent_runtime' },
        { migration_id: '007_future_change' },
      ],
    )

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/数据库版本高于当前服务支持/u)
  })
})
