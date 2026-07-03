// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全表 Schema 验证与默认策略种子
//
//   文件:       database.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
//
//   P0 重构 (2026-07-03):
//     启动期不再执行任何 CREATE/ALTER/INDEX/ADD COLUMN。
//     改为纯校验：缺表或缺列时抛出明确错误，提示运行 baseline migration。
//     保留 RBAC 默认 policy 的 INSERT seed（数据级，非 DDL）。
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Database } from '../db/connection.js'

const DEFAULT_POLICIES = [
  ['platform_admin', '*', '*', '*', 'allow'],
  ['workspace_admin', '*', 'workspace', 'read|update|admin', 'allow'],
  ['workspace_admin', '*', 'session', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'thread', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'run', 'read|create|update|delete|execute|approve|admin', 'allow'],
  ['workspace_admin', '*', 'artifact', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'dataset', 'read|create|update|delete|execute|admin', 'allow'],
  ['workspace_admin', '*', 'layer', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'tool', 'read|execute|approve', 'allow'],
  ['workspace_admin', '*', 'memory', 'read|create|update|delete|execute', 'allow'],
  ['workspace_admin', '*', 'speech', 'read|execute', 'allow'],
  ['analyst', '*', 'workspace', 'read', 'allow'],
  ['analyst', '*', 'session', 'read|create|update', 'allow'],
  ['analyst', '*', 'thread', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'run', 'read|create|execute|approve', 'allow'],
  ['analyst', '*', 'artifact', 'read|create', 'allow'],
  ['analyst', '*', 'dataset', 'read|create|execute', 'allow'],
  ['analyst', '*', 'layer', 'read|create|update', 'allow'],
  ['analyst', '*', 'tool', 'read|execute', 'allow'],
  ['analyst', '*', 'memory', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'speech', 'read|execute', 'allow'],
  ['viewer', '*', 'workspace', 'read', 'allow'],
  ['viewer', '*', 'session', 'read', 'allow'],
  ['viewer', '*', 'thread', 'read', 'allow'],
  ['viewer', '*', 'run', 'read', 'allow'],
  ['viewer', '*', 'artifact', 'read', 'allow'],
  ['viewer', '*', 'dataset', 'read', 'allow'],
  ['viewer', '*', 'layer', 'read', 'allow'],
  ['viewer', '*', 'tool', 'read', 'allow'],
  ['viewer', '*', 'memory', 'read', 'allow'],
  ['viewer', '*', 'speech', 'read', 'allow'],
] as const

// 核心安全/平台表 schema 定义（table → required columns）
const SECURITY_TABLES: Record<string, string[]> = {
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

// ensureSecurityTables 校验安全/平台核心表和关键列存在，缺即抛错。
// 不再执行任何 CREATE / ALTER / CREATE INDEX / ADD COLUMN。
// RBAC 默认 policy 的 INSERT seed 属于数据初始化，保留。
export async function ensureSecurityTables(db: Database): Promise<void> {
  await verifySchema(db, SECURITY_TABLES)

  // 数据级 seed：默认 RBAC policies（INSERT ... ON CONFLICT DO NOTHING）
  for (const policy of DEFAULT_POLICIES) {
    const policyId = hashPolicy(policy)
    await db.execute(sql`
      INSERT INTO platform_rbac_policies (policy_id, ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${policyId}, 'p', ${policy[0]}, ${policy[1]}, ${policy[2]}, ${policy[3]}, ${policy[4]}, '')
      ON CONFLICT DO NOTHING
    `)
  }
}

// verifySchema 校验 public schema 下 table→columns 均存在。
// 缺表或缺列时抛出包含 "baseline migration" 提示的错误。
export async function verifySchema(db: Database, required: Record<string, string[]>): Promise<void> {
  const tableNames = Object.keys(required)

  // 一次查询获取所有已存在表
  const tableResult = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (${sql.join(tableNames.map(table => sql`${table}`), sql`, `)})
  `)
  const existingTables = new Set(
    (tableResult.rows as Array<{ table_name: string }>).map(r => r.table_name),
  )
  const missingTables = tableNames.filter(t => !existingTables.has(t))

  // 逐表校验列（仅对已存在的表）
  const missingColumns: string[] = []
  for (const [table, columns] of Object.entries(required)) {
    if (!existingTables.has(table)) continue
    const colResult = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
    `)
    const existingCols = new Set(
      (colResult.rows as Array<{ column_name: string }>).map(r => r.column_name),
    )
    for (const col of columns) {
      if (!existingCols.has(col)) {
        missingColumns.push(`${table}.${col}`)
      }
    }
  }

  const errors: string[] = []
  if (missingTables.length) {
    errors.push(`缺少表: ${missingTables.join(', ')}`)
  }
  if (missingColumns.length) {
    errors.push(`缺少列: ${missingColumns.join(', ')}`)
  }
  if (errors.length) {
    throw new Error(
      `Schema 验证失败。请运行 baseline migration 或 reset 数据库。\n${errors.join('\n')}`,
    )
  }
}

function hashPolicy(parts: readonly string[]): string {
  return `policy_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}
