// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 会话基线显式重置命令
//
//   文件:       reset-conversation-store.mjs
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

if (!process.argv.includes('--confirm')) {
  console.error('拒绝重置：请显式传入 --confirm。')
  process.exit(2)
}

const root = path.resolve(process.cwd(), process.env.RUNTIME_ROOT || 'runtime')
for (const name of ['sessions', 'conversations', 'uploads', 'artifacts', 'objects']) {
  const target = path.resolve(root, name)
  if (target !== root && target.startsWith(`${root}${path.sep}`)) {
    await rm(target, { recursive: true, force: true })
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL 未配置，无法重置 PostgreSQL 会话事实源。')
}

const requiredTables = [
  'platform_sessions',
  'platform_threads',
  'platform_runs',
  'platform_conversation_entries',
  'platform_run_records',
  'platform_run_inputs',
  'platform_event_outbox',
  'platform_artifacts',
]
const resetTables = [
  'platform_meteorological_jobs',
  'platform_meteorological_datasets',
  'platform_artifacts',
  'platform_event_outbox',
  'platform_run_inputs',
  'platform_run_records',
  'platform_conversation_entries',
  'platform_runs',
  'platform_threads',
  'platform_sessions',
]

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const result = await client.query(
    'SELECT relname FROM pg_class WHERE relkind = $1 AND relname = ANY($2::text[])',
    ['r', requiredTables],
  )
  const existing = new Set(result.rows.map(row => String(row.relname)))
  const missing = requiredTables.filter(table => !existing.has(table))
  if (missing.length) {
    throw new Error(`数据库不是当前 GeoForge 基线，缺少表：${missing.join('、')}。请先应用 infra/migrations/001_init_postgis.sql。`)
  }
  await client.query(`TRUNCATE TABLE ${resetTables.join(', ')} RESTART IDENTITY CASCADE`)
} finally {
  await client.end()
}

console.log(`已重置 PostgreSQL 会话事实与运行时内容目录：${root}`)
