// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据路由测试
//
//   文件:       meteorology.test.ts
//
//   日期:       2026年07月01日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { ensureMeteorologicalTables, meteorologyRoutes } from './meteorology.js'
import { verifySchema } from '../security/database.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'

describe('meteorology routes', () => {
  it('passes threadId and filename query parameters into dataset filtering', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'workspace-test', 'session-a', 'thread-a', 'target.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'workspace-test', 'session-a', 'thread-b', 'target.nc', '2026-07-01T01:00:00.000Z'),
      datasetRow('dataset-c', 'workspace-test', 'session-a', 'thread-b', 'other.nc', '2026-07-01T02:00:00.000Z'),
      datasetRow('dataset-d', 'workspace-other', 'session-a', 'thread-b', 'target.nc', '2026-07-01T03:00:00.000Z'),
    ])
    const store = new PostgresPlatformStore(fixture.db, path.join(os.tmpdir(), 'geo-route-meteorology'))
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', TEST_AUTH)
      await next()
    })
    app.route('/', meteorologyRoutes(fixture.db, os.tmpdir(), store, testSecurity()))

    const response = await app.request('/api/v1/meteorology/datasets?threadId=thread-b&filename=target.nc')
    const rows = await response.json() as Array<{ datasetId: string }>

    expect(response.status).toBe(200)
    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
  })
})

interface CapturedQuery {
  text: string
  values: unknown[]
}

type DatasetRow = Record<string, unknown>

function createMeteorologicalDb(rows: DatasetRow[]): { db: Database; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = []
  const db = {
    execute: async (query: unknown) => {
      const captured = captureQuery(query)
      queries.push(captured)
      return { rows: filterRows(rows, captured) }
    },
  } as unknown as Database
  return { db, queries }
}

// 路由测试只解释本模块固定生成的谓词顺序，避免引入数据库服务依赖。
function filterRows(rows: DatasetRow[], query: CapturedQuery): DatasetRow[] {
  let valueIndex = 0
  const workspaceId = query.text.includes('workspace_id =') ? String(query.values[valueIndex++]) : null
  const sessionId = query.text.includes('session_id =') ? String(query.values[valueIndex++]) : null
  const threadId = query.text.includes('thread_id =') ? String(query.values[valueIndex++]) : null
  const filename = query.text.includes('lower(filename)') ? String(query.values[valueIndex++]).toLowerCase() : null
  const limit = Number(query.values.at(-1) ?? rows.length)

  return rows
    .filter(row => !workspaceId || row.workspace_id === workspaceId)
    .filter(row => !sessionId || row.session_id === sessionId)
    .filter(row => !threadId || row.thread_id === threadId)
    .filter(row => !filename || String(row.filename).toLowerCase() === filename)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Number.isFinite(limit) ? limit : rows.length)
}

function captureQuery(query: unknown): CapturedQuery {
  const text: string[] = []
  const values: unknown[] = []
  for (const chunk of chunksOf(query)) appendQueryChunk(chunk, text, values)
  return { text: text.join(''), values }
}

function appendQueryChunk(chunk: unknown, text: string[], values: unknown[]): void {
  const nested = queryChunks(chunk)
  if (nested.length) {
    for (const item of nested) appendQueryChunk(item, text, values)
    return
  }
  if (isStringChunk(chunk)) {
    text.push(chunk.value.join(''))
  } else {
    text.push('?')
    values.push(paramValue(chunk))
  }
}

function queryChunks(value: unknown): unknown[] {
  return Array.isArray((value as { queryChunks?: unknown }).queryChunks)
    ? (value as { queryChunks: unknown[] }).queryChunks
    : []
}

function paramValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return (value as { value: unknown }).value
  }
  return value
}

function isStringChunk(value: unknown): value is { value: string[] } {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { value?: unknown }).value)
    && (value as { value: unknown[] }).value.every(item => typeof item === 'string')
}

function datasetRow(
  datasetId: string,
  workspaceId: string,
  sessionId: string,
  threadId: string,
  filename: string,
  updatedAt: string,
): DatasetRow {
  return {
    dataset_id: datasetId,
    workspace_id: workspaceId,
    created_by_user_id: 'user-test',
    visibility: 'workspace',
    session_id: sessionId,
    thread_id: threadId,
    filename,
    original_filename: filename,
    file_id: `${datasetId}-file`,
    file_relative_path: `uploads/${filename}`,
    size_bytes: 1,
    content_hash: null,
    media_type: 'application/netcdf',
    status: 'ready',
    metadata_json: {},
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

const TEST_AUTH: AuthContext = {
  userId: 'user-test',
  subject: 'auth-user-test',
  email: 'tester@geoforge.local',
  displayName: '测试用户',
  authSessionId: 'session-test',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'csrf-test',
  defaultWorkspaceId: 'workspace-test',
  roles: [{ workspaceId: 'workspace-test', role: 'analyst' }],
}

function testSecurity(): SecurityServices {
  return {
    auth: {
      requireCsrf: () => {},
      isTrustedOrigin: () => true,
      authenticateRequest: async () => TEST_AUTH,
      isAuthContextActive: async () => true,
    },
    authorization: {
      enforce: async () => {},
      assertResourceWorkspace: async () => {},
      can: async () => true,
      audit: async () => {},
      reload: async () => {},
    },
    db: { execute: async () => ({ rows: [] }) } as unknown as Database,
  } as unknown as SecurityServices
}

// ---------------------------------------------------------------------------
// Schema verification tests for ensureMeteorologicalTables
// ---------------------------------------------------------------------------

interface FakeDbConfig {
  tables: Record<string, string[]>
}

function meteoFakeDb(config: FakeDbConfig): Database {
  return {
    execute: async (query: unknown) => {
      const text = sqlText(query)
      if (text.includes('information_schema.tables')) {
        // The ANY($1::text[]) param is the required table list; return all configured
        return { rows: Object.keys(config.tables).map(t => ({ table_name: t })) }
      }
      if (text.includes('information_schema.columns')) {
        // Single param: the table name
        const tableName = String(paramValues(query)[0] ?? '')
        const columns = config.tables[tableName] ?? []
        return { rows: columns.map(c => ({ column_name: c })) }
      }
      return { rows: [] }
    },
  } as unknown as Database
}

function sqlText(query: unknown): string {
  const parts: string[] = []
  for (const chunk of chunksOf(query)) {
    if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) {
      const arr = (chunk as { value: unknown[] }).value
      if (arr.every(item => typeof item === 'string')) parts.push(arr.join(''))
    }
  }
  return parts.join('')
}

function paramValues(query: unknown): unknown[] {
  const values: unknown[] = []
  for (const chunk of chunksOf(query)) {
    // Drizzle queryChunks: string parts are wrapped {value: string[]};
    // param values are raw scalars — skip objects.
    if (typeof chunk === 'object' && chunk !== null) continue
    values.push(chunk)
  }
  return values
}

function chunksOf(value: unknown): unknown[] {
  const qc = (value as { queryChunks?: unknown[] })?.queryChunks
  return Array.isArray(qc) ? qc : []
}

describe('ensureMeteorologicalTables', () => {
  it('passes when all meteorological tables and columns exist', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'workspace_id', 'created_by_user_id', 'visibility',
          'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
        ],
        platform_meteorological_jobs: [
          'job_id', 'dataset_id', 'workspace_id', 'created_by_user_id',
          'session_id', 'thread_id', 'kind', 'status', 'message',
          'payload_json', 'created_at', 'updated_at', 'completed_at',
        ],
      },
    })
    await expect(ensureMeteorologicalTables(db)).resolves.toBeUndefined()
  })

  it('throws when a meteorological table is missing', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'workspace_id', 'created_by_user_id', 'visibility',
          'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
        ],
        // missing platform_meteorological_jobs
      },
    })
    await expect(ensureMeteorologicalTables(db)).rejects.toThrow(/缺少表/)
  })

  it('throws when a meteorological column is missing', async () => {
    const db = meteoFakeDb({
      tables: {
        platform_meteorological_datasets: [
          'dataset_id', 'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
          'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
          'metadata_json', 'created_at', 'updated_at',
          // missing workspace_id, created_by_user_id, visibility
        ],
        platform_meteorological_jobs: [
          'job_id', 'dataset_id', 'workspace_id', 'created_by_user_id',
          'session_id', 'thread_id', 'kind', 'status', 'message',
          'payload_json', 'created_at', 'updated_at', 'completed_at',
        ],
      },
    })
    await expect(ensureMeteorologicalTables(db)).rejects.toThrow(/缺少列/)
  })
})
