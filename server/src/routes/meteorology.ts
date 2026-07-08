// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据 HTTP 数据面
//
//   文件:       meteorology.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 气象数据路由只索引当前 runtime 文件对象，不复制二进制数据。
// Agent 工具通过 datasetId / latest_upload 解析到同一条 fileRelativePath。

import { Hono } from 'hono'
import type { Database } from '../db/connection.js'
import type {
  MeteorologicalDatasetRecord,
  MeteorologicalJobRecord,
} from '../schemas/types.js'
import { RuntimeFileStore, type FileLike } from '../store/fileStore.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { MeteorologicalDatasetStore } from '../store/postgres/meteorologicalDatasetStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { Env } from '../framework/env.js'
import { verifySchema } from '../security/database.js'
import { HttpClientError, routeErrorResponse } from './errors.js'

const METEOROLOGICAL_SUFFIXES = [
  '.nc',
  '.nc4',
  '.grib',
  '.grb',
  '.grb2',
  '.tif',
  '.tiff',
  '.h5',
  '.hdf5',
  '.bz2',
] as const

const METEOROLOGICAL_TABLES: Record<string, string[]> = {
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
}

// ensureMeteorologicalTables 校验气象表及关键列存在；不再执行任何 DDL。
export async function ensureMeteorologicalTables(db: Database): Promise<void> {
  await verifySchema(db, METEOROLOGICAL_TABLES)
}

export function meteorologyRoutes(db: Database, runtimeRoot: string, store: PostgresPlatformStore, security: SecurityServices, env?: Env) {
  const files = new RuntimeFileStore(runtimeRoot)
  const app = new Hono()

  app.get('/api/v1/meteorology/datasets', async c => {
    const auth = requireAuth(c)
    const sessionId = queryString(c.req.query('sessionId') ?? c.req.query('session_id'))
    const threadId = queryString(c.req.query('threadId') ?? c.req.query('thread_id'))
    const filename = queryString(c.req.query('filename'))
    await security.authorization.enforce(auth, 'dataset', 'read', { workspaceId: auth.defaultWorkspaceId })
    const rows = await store.listMeteorologicalDatasets({ workspaceId: auth.defaultWorkspaceId, sessionId, threadId, filename })
    return c.json(rows)
  })

  app.post('/api/v1/meteorology/datasets', async c => {
    try {
      enforceContentLength(c.req.header('content-length'), env?.MAX_METEOROLOGY_UPLOAD_BYTES)
      const auth = requireAuth(c)
      const form = await c.req.formData()
      const sessionId = formString(form, 'sessionId') ?? formString(form, 'session_id')
      if (!sessionId) return c.json({ detail: 'sessionId 不能为空。' }, 400)
      const session = store.getSession(sessionId)
      await security.authorization.assertResourceWorkspace(auth, 'session', 'update', {
        workspaceId: session.workspaceId,
        createdByUserId: session.createdByUserId,
        visibility: session.visibility,
        resourceId: session.id,
      })
      await security.authorization.enforce(auth, 'dataset', 'create', { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId })
      const threadId = formString(form, 'threadId') ?? formString(form, 'thread_id')
      const file = requireFile(form.get('file'))
      if (!isSupportedMeteorologicalFilename(file.name)) {
        return c.json({ detail: `不支持的气象数据格式：${file.name}` }, 415)
      }

      const sourceRelativePath = formString(form, 'sourceRelativePath') ?? formString(form, 'relativePath')
      const stored = await files.save(file, threadId, null, sourceRelativePath)
      if (threadId) await store.recordAttachment(threadId, stored)
      const now = nowUtc()
      const dataset: MeteorologicalDatasetRecord = {
        datasetId: makeId('meteorological_dataset'),
        workspaceId: session.workspaceId,
        createdByUserId: auth?.userId ?? session.createdByUserId,
        visibility: 'workspace',
        sessionId,
        threadId,
        filename: stored.name,
        originalFilename: file.name,
        fileId: stored.id,
        fileRelativePath: stored.relativePath,
        sizeBytes: stored.sizeBytes,
        contentHash: stored.contentHash,
        mediaType: stored.mediaType,
        status: 'ready',
        metadata: {
          source: 'upload',
          inputKind: inputKind(stored.name),
          ...(stored.sourceRelativePath ? { sourceRelativePath: stored.sourceRelativePath } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }
      await store.createMeteorologicalDataset(dataset)
      await store.updateSession(sessionId, { latestMeteorologicalDatasetId: dataset.datasetId })
      return c.json({ dataset, job: null })
    } catch (error) {
      const response = routeErrorResponse(error, '气象数据上传失败。')
      return c.json({ detail: response.detail }, response.status as never)
    }
  })

  app.get('/api/v1/meteorology/jobs/:jobId', async c => {
    const job = await store.getMeteorologicalJob(c.req.param('jobId'))
    if (!job) return c.json({ detail: '气象处理任务不存在' }, 404)
    await security.authorization.assertResourceWorkspace(requireAuth(c), 'dataset', 'read', {
      workspaceId: job.workspaceId,
      createdByUserId: job.createdByUserId,
      resourceId: job.datasetId,
    })
    return c.json(job)
  })

  app.post('/api/v1/meteorology/datasets/:datasetId/report', async c => {
    const dataset = await store.getMeteorologicalDataset(c.req.param('datasetId'))
    if (!dataset) return c.json({ detail: '气象数据集不存在' }, 404)
    const auth = requireAuth(c)
    await security.authorization.assertResourceWorkspace(auth, 'dataset', 'execute', {
      workspaceId: dataset.workspaceId,
      createdByUserId: dataset.createdByUserId,
      visibility: dataset.visibility,
      resourceId: dataset.datasetId,
    })
    const now = nowUtc()
    const payload = await safeJson(c.req.raw)
    const job: MeteorologicalJobRecord = {
      jobId: makeId('meteorological_job'),
      datasetId: dataset.datasetId,
      workspaceId: dataset.workspaceId,
      createdByUserId: auth?.userId ?? dataset.createdByUserId,
      sessionId: dataset.sessionId,
      threadId: dataset.threadId,
      kind: 'report',
      status: 'queued',
      message: '气象报告任务已创建；报告正文必须由 meteorological_report 工具基于 interpretation_ref 生成。',
      payload,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await store.createMeteorologicalJob(job)
    return c.json(job, 202)
  })

  return app
}

function enforceContentLength(value: string | undefined, limit?: number): void {
  if (!limit || !value) return
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > limit) {
    throw new HttpClientError(`气象数据文件过大，限制为 ${Math.round(limit / 1024 / 1024)}MB。`, 413)
  }
}

export async function resolveLatestMeteorologicalDataset(
  db: Database,
  params: { sessionId: string; threadId?: string | null; datasetId?: string | null; filename?: string | null },
): Promise<MeteorologicalDatasetRecord | null> {
  const datasetStore = new MeteorologicalDatasetStore(db)
  if (params.datasetId && params.datasetId !== 'latest_upload') {
    return datasetStore.get(params.datasetId)
  }
  const matches = await datasetStore.list({
    sessionId: params.sessionId,
    threadId: params.threadId ?? null,
    filename: params.filename ?? null,
    limit: 1,
  })
  return matches[0] ?? null
}

function isSupportedMeteorologicalFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return METEOROLOGICAL_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function inputKind(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.bz2')) return 'radar'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'raster'
  return 'dataset'
}

function requireFile(value: unknown): FileLike {
  if (!isFileLike(value)) throw new HttpClientError('缺少上传文件。')
  return value
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key)
  return queryString(value)
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isFileLike(value: unknown): value is FileLike {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
    && 'arrayBuffer' in value
    && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json()
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
