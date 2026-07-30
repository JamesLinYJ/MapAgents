// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库连接
//
//   文件:       connection.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'
import { errorLogPayload, logger } from '../observability/logger.js'

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>

export type Database = DrizzleDatabase & {
  pool: Pool
  close: () => Promise<void>
}

export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export function createDb(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  })
  pool.on('error', error => {
    logger.warn({ error: errorLogPayload(error) }, 'db idle client error')
  })
  const db = drizzle(pool, { schema }) as DrizzleDatabase
  return Object.assign(db, {
    pool,
    close: () => pool.end(),
  }) satisfies Database
}
