// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 健康检查测试
//
//   文件:       postgis.test.ts
//
//   日期:       2026年07月03日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostGisRepository } from './postgis.js'

describe('PostGisRepository.status', () => {
  it('requires a PostGIS version row instead of accepting a plain database ping', async () => {
    const postgis = new PostGisRepository(fakeDb([]))

    await expect(postgis.status()).resolves.toEqual({
      available: false,
      error: 'PostGIS 扩展未返回版本信息',
    })
  })

  it('reports available when the PostGIS extension responds with a version', async () => {
    const postgis = new PostGisRepository(fakeDb([{ version: '3.5.0' }]))

    await expect(postgis.status()).resolves.toEqual({ available: true, error: null })
  })

  it('reports unavailable when the PostGIS function fails', async () => {
    const postgis = new PostGisRepository(failingDb(new Error('function postgis_version() does not exist')))

    const result = await postgis.status()

    expect(result.available).toBe(false)
    expect(result.error).toContain('postgis_version')
  })
})

function fakeDb(rows: Record<string, unknown>[]): Database {
  return {
    execute: async () => ({ rows }),
  } as unknown as Database
}

function failingDb(error: Error): Database {
  return {
    execute: async () => { throw error },
  } as unknown as Database
}
