// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台持久化纯工具
//
//   文件:       platformStoreUtils.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 平台 store 的无状态 row mapper、游标和摘要工具集中在这里。
// PostgresPlatformStore 只保留状态索引、持久化调用和事件发布边界。

import type {
  AnalysisRun,
  MeteorologicalDatasetRecord,
  RunSummary,
} from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'

export interface ToolCatalogRow {
  toolKind: string
  toolName: string
  payload: Record<string, unknown>
  sortOrder: number
}

interface RunCursor {
  updatedAt: string
  id: string
}

export function mapToolCatalogRow(row: Record<string, unknown>): ToolCatalogRow {
  return {
    toolKind: String(row.tool_kind ?? ''),
    toolName: String(row.tool_name ?? ''),
    payload: isRecord(row.payload_json) ? row.payload_json : {},
    sortOrder: Number(row.sort_order ?? 0),
  }
}

export function mapMeteorologicalDatasetRow(row: Record<string, unknown>): MeteorologicalDatasetRecord {
  return {
    datasetId: String(row.dataset_id ?? ''),
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
    createdByUserId: typeof row.created_by_user_id === 'string' ? row.created_by_user_id : null,
    visibility: row.visibility === 'private' || row.visibility === 'public' ? row.visibility : 'workspace',
    sessionId: String(row.session_id ?? ''),
    threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
    filename: String(row.filename ?? ''),
    originalFilename: String(row.original_filename ?? row.filename ?? ''),
    fileId: typeof row.file_id === 'string' ? row.file_id : null,
    fileRelativePath: String(row.file_relative_path ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    contentHash: typeof row.content_hash === 'string' ? row.content_hash : null,
    mediaType: String(row.media_type ?? 'application/octet-stream'),
    status: String(row.status ?? 'ready'),
    metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

export function compareRuns(left: AnalysisRun, right: AnalysisRun): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
}

export function isRunAfterCursor(run: AnalysisRun, cursor: RunCursor): boolean {
  return run.updatedAt < cursor.updatedAt || (run.updatedAt === cursor.updatedAt && run.id < cursor.id)
}

export function encodeRunCursor(run: Pick<AnalysisRun, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id }), 'utf8').toString('base64url')
}

export function decodeRunCursor(cursor: string): RunCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('游标结构无效')
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id }
  } catch {
    throw new Error('cursor 无效')
  }
}

export function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isNaN(parsed.getTime()) ? nowUtc() : parsed.toISOString()
}

export function toRunSummary(run: AnalysisRun): RunSummary {
  const latestArtifact = run.state.artifacts.at(-1) ?? null
  return {
    id: run.id,
    threadId: run.threadId,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactCount: run.state.artifacts.length,
    latestArtifactId: latestArtifact?.artifactId ?? null,
    latestArtifactName: latestArtifact?.name ?? null,
  }
}

export function belongsToWorkspace(
  record: MeteorologicalDatasetRecord | null,
  workspaceId?: string | null,
): record is MeteorologicalDatasetRecord {
  if (!record) return false
  if (!workspaceId) return true
  return record.workspaceId === workspaceId
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function dedupeById<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map(value => [key(value), value])).values()]
}

export function splitMemoryContent(content: string): { generatedContent: string; pinnedContent: string } {
  const start = '<!-- user-notes:start -->'
  const end = '<!-- user-notes:end -->'
  const startIndex = content.indexOf(start)
  const endIndex = content.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) return { generatedContent: content, pinnedContent: '' }
  return {
    generatedContent: `${content.slice(0, startIndex)}${content.slice(endIndex + end.length)}`.trim(),
    pinnedContent: content.slice(startIndex + start.length, endIndex).trim(),
  }
}
