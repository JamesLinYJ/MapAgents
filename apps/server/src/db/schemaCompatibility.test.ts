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

function currentCapabilities(overrides: Record<string, unknown> = {}) {
  return {
    vector_tile_function: 'geo_agent_platform_layer_tiles(integer,integer,integer,json)',
    model_result_cache_table: 'platform_model_result_cache',
    file_objects_table: 'platform_file_objects',
    model_providers_table: 'platform_model_providers',
    run_domain_events_table: 'platform_run_domain_events',
    run_snapshots_table: 'platform_run_snapshots',
    geo_world_snapshots_table: 'platform_geo_world_snapshots',
    geo_world_diffs_table: 'platform_geo_world_diffs',
    agent_step_contexts_table: 'platform_agent_step_contexts',
    model_request_records_table: 'platform_model_request_records',
    tool_invocations_table: 'platform_tool_invocations',
    geo_world_snapshot_primary_key: true,
    agent_step_world_foreign_key: true,
    run_input_mailbox: true,
    ...overrides,
  }
}

function databaseWithCapabilities(capabilities: Record<string, unknown>) {
  return {
    execute: vi.fn().mockResolvedValueOnce({ rows: [capabilities] }),
  }
}

describe('verifyDatabaseSchemaCompatibility', () => {
  it('接受由单一权威基线创建的当前结构', async () => {
    const db = databaseWithCapabilities(currentCapabilities())

    await expect(verifyDatabaseSchemaCompatibility(db as never)).resolves.toBeUndefined()
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('拒绝固定瓦片函数缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ vector_tile_function: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/geo_agent_platform_layer_tiles\(integer, integer, integer, json\)/u)
  })

  it.each([
    ['model_result_cache_table', /platform_model_result_cache/u],
    ['file_objects_table', /platform_file_objects/u],
    ['model_providers_table', /platform_model_providers/u],
  ] as const)('拒绝缺少基线能力 %s 的数据库', async (field, expected) => {
    const db = databaseWithCapabilities(currentCapabilities({ [field]: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never)).rejects.toThrow(expected)
  })

  it('拒绝 Run input mailbox 列不完整的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ run_input_mailbox: false }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/Run input mailbox\/model-request\/terminal claim/u)
  })

  it('拒绝 Run domain journal 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ run_domain_events_table: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/Run domain journal\/snapshot/u)
  })

  it('拒绝 GeoWorld 或 StepContext 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ agent_step_contexts_table: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/GeoWorld\/Agent StepContext/u)
  })

  it('拒绝精确 ModelRequest journal 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ model_request_records_table: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/GeoWorld\/Agent StepContext\/ModelRequest/u)
  })

  it('拒绝仍会覆盖历史 GeoWorld 的单列主键草案', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ geo_world_snapshot_primary_key: false }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/追加式主键/u)
  })

  it('所有错误都指向空库权威基线而不是增量迁移', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ vector_tile_function: null }))

    await expect(verifyDatabaseSchemaCompatibility(db as never))
      .rejects.toThrow(/infra\/database\/schema\.sql/u)
  })
})
