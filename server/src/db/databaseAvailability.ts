// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 数据库可用性边界
//
//   文件:       databaseAvailability.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { Database } from './connection.js'

const CONNECTION_ERROR_CODE = /^(?:08[A-Z0-9]{3}|57P0[123]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/u

/** 将已确认的连接故障跨越会吞掉底层 cause 的第三方边界继续传递。 */
export class DatabaseUnavailableError extends Error {
  readonly code = 'DATABASE_UNAVAILABLE'

  constructor(cause: unknown) {
    super('数据库连接当前不可用。', { cause })
    this.name = 'DatabaseUnavailableError'
  }
}

/** 只把连接级故障判定为短暂不可用，约束、schema 与编程错误必须原样硬失败。 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const pending: unknown[] = [error]
  const visited = new Set<object>()

  while (pending.length > 0 && visited.size < 16) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)

    const record = current as { code?: unknown; cause?: unknown; errors?: unknown }
    const code = typeof record.code === 'string' ? record.code.toUpperCase() : ''
    if (code === 'DATABASE_UNAVAILABLE' || CONNECTION_ERROR_CODE.test(code)) return true
    if (record.cause) pending.push(record.cause)
    if (Array.isArray(record.errors)) pending.push(...record.errors)
  }
  return false
}

/**
 * Better Auth 会把 getSession 的底层适配器异常规范化为 APIError，且不保留 cause。
 * 这里只做连接健康探测：探测成功则原错误仍是硬失败，探测确认连接故障才转换类型。
 */
export async function assertDatabaseReachable(db: Pick<Database, 'pool'>): Promise<void> {
  try {
    await db.pool.query('SELECT 1')
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw new DatabaseUnavailableError(error)
    throw error
  }
}
