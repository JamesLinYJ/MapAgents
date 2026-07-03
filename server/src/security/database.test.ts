// +-------------------------------------------------------------------------
//
//   地理智能平台 - Schema 验证单元测试
//
//   文件:       database.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//
//   verifySchema / ensureSecurityTables 在缺表/缺列时抛出的错误必须
//   包含 "baseline migration" 指引，不连接真实数据库。
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { verifySchema, ensureSecurityTables } from './database.js'

// ---------------------------------------------------------------------------
// 假 DB：根据预置的 table → columns 映射响应对 information_schema 的查询
// ---------------------------------------------------------------------------

interface FakeDbConfig {
  tables: Record<string, string[]> // table → existing columns
  executedSql?: string[]
}

function fakeDb(config: FakeDbConfig): Database {
  return {
    execute: async (query: unknown) => {
      const text = sqlText(query)
      config.executedSql?.push(text)
      if (text.includes('information_schema.tables')) {
        return { rows: Object.keys(config.tables).map(t => ({ table_name: t })) }
      }
      if (text.includes('information_schema.columns')) {
        // Single param: the table name
        const tableName = String(paramValues(query)[0] ?? '')
        const columns = config.tables[tableName] ?? []
        return { rows: columns.map(c => ({ column_name: c })) }
      }
      // INSERT / other: succeed silently
      return { rows: [] }
    },
  } as unknown as Database
}

function completeSecurityTables(): Record<string, string[]> {
  return {
    auth_user: ['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at'],
    auth_session: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'user_id'],
    auth_account: ['id', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
    auth_verification: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
    platform_users: ['user_id', 'subject', 'email', 'display_name', 'status', 'last_login_at', 'created_at', 'updated_at'],
    platform_workspaces: ['workspace_id', 'name', 'description', 'status', 'created_by_user_id', 'created_at', 'updated_at'],
    platform_memberships: ['membership_id', 'workspace_id', 'user_id', 'role', 'created_at'],
    platform_rbac_policies: ['policy_id', 'ptype', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
    platform_audit_events: ['audit_event_id', 'actor_user_id', 'workspace_id', 'action', 'object_type', 'object_id', 'outcome', 'metadata_json', 'created_at'],
    platform_artifacts: ['artifact_id', 'run_id', 'artifact_type', 'name', 'uri', 'metadata_json', 'geojson_relative_path', 'created_at', 'workspace_id', 'created_by_user_id', 'visibility'],
  }
}

// ---------------------------------------------------------------------------
// helpers — extract text and param values from drizzle SQL query chunks
// ---------------------------------------------------------------------------

function sqlText(query: unknown): string {
  const parts: string[] = []
  for (const chunk of queryChunks(query)) appendSqlText(chunk, parts)
  return parts.join('')
}

function paramValues(query: unknown): unknown[] {
  const values: unknown[] = []
  for (const chunk of queryChunks(query)) appendParamValues(chunk, values)
  return values
}

function queryChunks(value: unknown): unknown[] {
  const qc = (value as { queryChunks?: unknown[] })?.queryChunks
  return Array.isArray(qc) ? qc : []
}

function appendSqlText(chunk: unknown, parts: string[]): void {
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) {
    const arr = (chunk as { value: unknown[] }).value
    if (arr.every(item => typeof item === 'string')) parts.push(arr.join(''))
    return
  }
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
    for (const nested of (chunk as { queryChunks: unknown[] }).queryChunks) appendSqlText(nested, parts)
  }
}

function appendParamValues(chunk: unknown, values: unknown[]): void {
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) return
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
    for (const nested of (chunk as { queryChunks: unknown[] }).queryChunks) appendParamValues(nested, values)
    return
  }
  values.push(chunk)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('verifySchema', () => {
  it('succeeds when all tables and columns exist', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id', 'subject'],
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id', 'subject'],
      }),
    ).resolves.toBeUndefined()
  })

  it('throws when a required table is missing', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name', 'email'],
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id'],
      }),
    ).rejects.toThrow(/Schema 验证失败/)
  })

  it('error message mentions baseline migration 或 reset', async () => {
    const db = fakeDb({ tables: {} })
    await expect(
      verifySchema(db, { missing_table: ['col_a'] }),
    ).rejects.toThrow(/baseline migration|reset/)
  })

  it('throws when a column is missing on an existing table', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name'], // missing 'email'
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
      }),
    ).rejects.toThrow(/缺少列/)
  })

  it('lists all missing tables in the error', async () => {
    const db = fakeDb({ tables: {} })
    await expect(
      verifySchema(db, {
        table_a: ['col_a'],
        table_b: ['col_b'],
      }),
    ).rejects.toThrow(/table_a/)
  })

  it('lists all missing columns in the error', async () => {
    const db = fakeDb({
      tables: { auth_user: ['id'] },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
      }),
    ).rejects.toThrow(/auth_user\.name/)
  })

  it('uses an IN parameter list instead of casting a record to text array', async () => {
    const executedSql: string[] = []
    const db = fakeDb({
      tables: {
        auth_user: ['id'],
        platform_users: ['user_id'],
      },
      executedSql,
    })

    await verifySchema(db, {
      auth_user: ['id'],
      platform_users: ['user_id'],
    })

    expect(executedSql[0]).toContain('table_name IN')
    expect(executedSql[0]).not.toContain('ANY((')
  })
})

describe('ensureSecurityTables', () => {
  it('passes when all security tables and columns exist', async () => {
    const db = fakeDb({
      tables: completeSecurityTables(),
    })
    await expect(ensureSecurityTables(db)).resolves.toBeUndefined()
  })

  it('does not execute DDL during startup schema verification', async () => {
    const executedSql: string[] = []
    const db = fakeDb({
      tables: completeSecurityTables(),
      executedSql,
    })
    await ensureSecurityTables(db)
    expect(executedSql.join('\n')).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i)
  })

  it('throws when a security table is missing', async () => {
    const db = fakeDb({
      tables: {
        // missing auth_user entirely
        auth_session: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'user_id'],
        auth_account: ['id', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
        auth_verification: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
        platform_users: ['user_id', 'subject', 'email', 'display_name', 'status', 'last_login_at', 'created_at', 'updated_at'],
        platform_workspaces: ['workspace_id', 'name', 'description', 'status', 'created_by_user_id', 'created_at', 'updated_at'],
        platform_memberships: ['membership_id', 'workspace_id', 'user_id', 'role', 'created_at'],
        platform_rbac_policies: ['policy_id', 'ptype', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
        platform_audit_events: ['audit_event_id', 'actor_user_id', 'workspace_id', 'action', 'object_type', 'object_id', 'outcome', 'metadata_json', 'created_at'],
        platform_artifacts: ['artifact_id', 'run_id', 'artifact_type', 'name', 'uri', 'metadata_json', 'geojson_relative_path', 'created_at', 'workspace_id', 'created_by_user_id', 'visibility'],
      },
    })
    await expect(ensureSecurityTables(db)).rejects.toThrow(/缺少表/)
  })
})
