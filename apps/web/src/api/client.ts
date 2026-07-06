// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 客户端
//
//   文件:       client.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 封装 WebSocket 控制面与受限 HTTP 数据面的请求入口和统一错误处理。

import type {
  ConversationItem,
  AgentExecutionMode,
  AgentRuntimeConfig,
  AuthMe,
  AnalysisRun,
  AgentThreadRecord,
  BasemapDescriptor,
  LayerDescriptor,
  MemoryFileRecord,
  MemorySearchResult,
  MeteorologicalDatasetRecord,
  MeteorologicalJobRecord,
  ModelProviderDescriptor,
  RunEvent,
  RunSummaryPage,
  SessionRecord,
  SpeechAuthorization,
  SystemComponentsStatus,
  ToolDescriptor,
  ThreadDetailSnapshot,
  ThreadHistoryPage,
  ThreadMemoryDocument,
  ContextAssemblyReport,
  CompactionRecord,
  WorkspaceBootstrapSnapshot,
} from '@geo-agent-platform/shared-types'

// 响应协议校验 — 在关键 HTTP / WS 入口用后端共用的 Zod schema 解析，
// 避免裸 as T 掩藏协议不匹配。
import {
  authMeSchema,
  sessionRecordSchema,
  analysisRunSchema,
  agentThreadRecordSchema,
  basemapDescriptorSchema,
  meteorologicalDatasetRecordSchema,
  meteorologicalJobRecordSchema,
  agentRuntimeConfigSchema,
  systemComponentsStatusSchema,
  toolDescriptorSchema,
  modelProviderDescriptorSchema,
  layerDescriptorSchema,
  memoryFileRecordSchema,
  memorySearchResultSchema,
  speechAuthorizationSchema,
  compactionRecordSchema,
  threadMemoryDocumentSchema,
  contextAssemblyReportSchema,
  conversationItemSchema,
  runEventSchema,
  runSummarySchema,
} from '@geo-agent-platform/shared-types'
import { signOutWithBetterAuth } from './authClient'
import {
  csrfHeaders,
  requestControl,
  requestFormJson,
  requestJson,
  setAuthContext,
} from './transport'
import type { ResponseSchema, SchemaParseError } from './transport'

export type { ResponseSchema, SchemaParseError } from './transport'
export {
  apiBaseUrl,
  deriveApiBaseUrl,
  formatApiErrorMessage,
  formatSchemaValidationError,
  setAuthContext,
} from './transport'

// -- 响应 Schema 校验工具 --------------------------------------------------

/** 将单项 schema 组合为数组 schema */
export function arraySchema<T>(itemSchema: ResponseSchema<T>): ResponseSchema<T[]> {
  return {
    safeParse(data: unknown) {
      if (!Array.isArray(data)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: '预期为数组格式' }] },
        }
      }
      const result: T[] = []
      for (let i = 0; i < data.length; i++) {
        const r = itemSchema.safeParse(data[i])
        if (!r.success) {
          return {
            success: false,
            error: {
              issues: r.error.issues.map((issue) => ({
                path: [i, ...issue.path],
                message: issue.message,
              })),
            },
          }
        }
        result.push(r.data)
      }
      return { success: true, data: result }
    },
  }
}

/** 将单项 schema 包装为可空 schema */
export function nullableSchema<T>(itemSchema: ResponseSchema<T>): ResponseSchema<T | null> {
  return {
    safeParse(data: unknown) {
      if (data === null || data === undefined) return { success: true, data: null }
      return itemSchema.safeParse(data) as { success: true; data: T | null } | { success: false; error: SchemaParseError }
    },
  }
}

// -- 组合 schema -----------------------------------------------------------
//
// 对 { items: T[]; nextCursor: string | null } 这类分页响应包装 Zod 校验，
// 避免后端接口升级后 items 内部字段漂移被裸 as T 掩藏。

function pageItemsSchema<T>(itemSchema: ResponseSchema<T>): ResponseSchema<{ items: T[]; nextCursor: string | null }> {
  return {
    safeParse(data: unknown) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { success: false, error: { issues: [{ path: [], message: '预期为分页对象' }] } }
      }
      const obj = data as Record<string, unknown>
      if (!Array.isArray(obj.items)) {
        return { success: false, error: { issues: [{ path: ['items'], message: 'items 字段缺失或不是数组' }] } }
      }
      const itemsResult = arraySchema(itemSchema).safeParse(obj.items)
      if (!itemsResult.success) return { success: false, error: itemsResult.error }
      return { success: true, data: { items: itemsResult.data, nextCursor: (typeof obj.nextCursor === 'string' ? obj.nextCursor : null) } }
    },
  }
}

const runSummaryPageSchema = pageItemsSchema(runSummarySchema)

const memorySearchResultPageSchema: ResponseSchema<{ matches: MemorySearchResult[]; total: number }> = {
  safeParse(data: unknown) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { success: false, error: { issues: [{ path: [], message: '预期为对象' }] } }
    }
    const obj = data as Record<string, unknown>
    if (!Array.isArray(obj.matches)) {
      return { success: false, error: { issues: [{ path: ['matches'], message: 'matches 字段缺失或不是数组' }] } }
    }
    const matchesResult = arraySchema(memorySearchResultSchema).safeParse(obj.matches)
    if (!matchesResult.success) return { success: false, error: matchesResult.error }
    return { success: true, data: { matches: matchesResult.data, total: typeof obj.total === 'number' ? obj.total : 0 } }
  },
}

const subscribeRunResponseSchema: ResponseSchema<{ run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }> = {
  safeParse(data: unknown) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { success: false, error: { issues: [{ path: [], message: '预期为对象' }] } }
    }
    const obj = data as Record<string, unknown>
    const runResult = analysisRunSchema.safeParse(obj.run)
    if (!runResult.success) return runResult
    const itemsResult = arraySchema(conversationItemSchema).safeParse(obj.items)
    if (!itemsResult.success) return itemsResult
    const eventsResult = arraySchema(runEventSchema).safeParse(obj.events)
    if (!eventsResult.success) return eventsResult
    return { success: true, data: { run: runResult.data, items: itemsResult.data, events: eventsResult.data } }
  },
}

export async function logout() {
  await signOutWithBetterAuth()
  setAuthContext(null)
}

export async function getAuthMe() {
  const auth = await requestJson<AuthMe>('/api/v1/auth/me', undefined, 30_000, authMeSchema)
  setAuthContext(auth)
  return auth
}

export function listAdminUsers() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/admin/users')
}

export function updateAdminUser(userId: string, payload: Record<string, unknown>) {
  return requestJson<Record<string, unknown>>(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  })
}

export function listAdminWorkspaces() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/admin/workspaces')
}

export function createAdminWorkspace(payload: { name: string; description?: string }) {
  return requestJson<Record<string, unknown>>('/api/v1/admin/workspaces', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  })
}

export function listAdminMemberships(workspaceId?: string | null) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return requestJson<Array<Record<string, unknown>>>(`/api/v1/admin/memberships${query}`)
}

export function createAdminMembership(payload: { workspaceId: string; userId: string; role: string }) {
  return requestJson<Record<string, unknown>>('/api/v1/admin/memberships', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
  })
}

export function deleteAdminMembership(membershipId: string) {
  return requestJson<Record<string, unknown>>(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  })
}

export function listAdminRoles() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/admin/roles')
}

export function listAuditEvents() {
  return requestJson<Array<Record<string, unknown>>>('/api/v1/admin/audit-events')
}

export function createSession() {
  return requestControl<SessionRecord>('session:get-default', {}, sessionRecordSchema)
}

export function bootstrapWorkspace(sessionId?: string) {
  // WorkspaceBootstrapSnapshot 暂无独立 Zod schema，保持裸类型断言。
  return requestControl<WorkspaceBootstrapSnapshot>('workspace:bootstrap', { sessionId })
}

export function getDefaultSession() {
  // 默认工作台会话
  //
  // 返回跨浏览器/设备的稳态服务器端会话。
  // 前端不再用 localStorage 决定”历史属于哪个会话”，
  // 而是统一从这个端点获取确定性默认会话。
  return requestControl<SessionRecord>('session:get-default', {}, sessionRecordSchema)
}

export function getSession(sessionId: string) {
  return requestControl<SessionRecord>('session:get', { sessionId }, sessionRecordSchema)
}

export function listSessionThreads(sessionId: string) {
  // 任务历史现在以 thread 作为主索引，而不是把每次 run 都当成独立任务。
  return requestControl<AgentThreadRecord[]>('thread:list', { sessionId }, arraySchema(agentThreadRecordSchema))
}

export function createThread(sessionId: string, title?: string) {
  // v2 thread/run 模型下，thread 负责承接多轮上下文与历史恢复。
  return requestControl<AgentThreadRecord>('thread:create', { sessionId, title }, agentThreadRecordSchema)
}

export function getThread(threadId: string) {
  // ThreadDetailSnapshot 暂无独立 Zod schema，保持裸类型断言。
  return requestControl<ThreadDetailSnapshot>('thread:get', { threadId })
}

export function updateThread(threadId: string, title: string) {
  return requestControl<AgentThreadRecord>('thread:update', { threadId, title }, agentThreadRecordSchema)
}

export function deleteThread(threadId: string) {
  return requestControl<{ deleted: boolean; threadId: string }>('thread:delete', { threadId })
}

export function listRunSummaries(
  sessionId: string,
  options: { threadId?: string | null; cursor?: string | null; limit?: number } = {},
) {
  return requestControl<RunSummaryPage>('run:list', { sessionId, ...options }, runSummaryPageSchema)
}

export function getThreadHistory(threadId: string, cursor?: string | null, limit = 100) {
  return requestControl<ThreadHistoryPage>('thread:history', { threadId, cursor, limit })
}

export function forkThread(threadId: string, entryId: string, title?: string) {
  return requestControl<AgentThreadRecord>('thread:fork', { threadId, entryId, title })
}

export function compactThread(threadId: string) {
  return requestControl<CompactionRecord | null>('thread:compact', { threadId }, nullableSchema(compactionRecordSchema))
}

export function getThreadContext(threadId: string) {
  return requestControl<ContextAssemblyReport>('thread:context', { threadId }, contextAssemblyReportSchema)
}

export function getThreadMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('thread:memory:get', { threadId }, threadMemoryDocumentSchema)
}

export function updateThreadMemory(threadId: string, content: string, expectedVersion: number) {
  return requestControl<ThreadMemoryDocument>('thread:memory:update', { threadId, content, expectedVersion }, threadMemoryDocumentSchema)
}

export function rebuildThreadMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('thread:memory:rebuild', { threadId }, threadMemoryDocumentSchema)
}

export function listMemories(scope?: 'private' | 'team') {
  return requestControl<{ records: MemoryFileRecord[]; total: number }>('memory:list', { scope })
}

export function readMemory(scope: 'private' | 'team', relativePath: string) {
  return requestControl<MemoryFileRecord>('memory:read', { scope, relativePath }, memoryFileRecordSchema)
}

export function writeMemory(payload: {
  scope: 'private' | 'team'
  type: 'user' | 'feedback' | 'project' | 'reference'
  name: string
  description: string
  content: string
  relativePath?: string | null
}) {
  return requestControl<MemoryFileRecord>('memory:write', payload, memoryFileRecordSchema)
}

export function deleteMemory(scope: 'private' | 'team', relativePath: string) {
  return requestControl<{ deleted: boolean; relativePath: string }>('memory:delete', { scope, relativePath })
}

export function searchMemories(query: string) {
  return requestControl<{ matches: MemorySearchResult[]; total: number }>('memory:search', { query }, memorySearchResultPageSchema)
}

export function extractMemories(threadId: string, runId?: string | null) {
  return requestControl<{ records: MemoryFileRecord[]; total: number }>('memory:extract', { threadId, runId })
}

export function dreamMemories(force = false) {
  return requestControl<{ changed: boolean; message: string; records: MemoryFileRecord[]; summary?: string; warnings?: string[] }>('memory:dream', { force })
}

export function getSessionMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('memory:session:get', { threadId })
}

export function rebuildSessionMemory(threadId: string) {
  return requestControl<ThreadMemoryDocument>('memory:session:rebuild', { threadId })
}

export function listInstructionMemories() {
  return requestControl<{ enabled: boolean; entrypointName: string; records: MemoryFileRecord[] }>('memory:instructions:list')
}

export function listTrashedThreads(sessionId: string) {
  return requestControl<Array<{ thread: AgentThreadRecord; deletedAt: string; purgeAfter: string }>>('thread:trash:list', { sessionId })
}

export function restoreThread(threadId: string) {
  return requestControl<AgentThreadRecord>('thread:trash:restore', { threadId }, agentThreadRecordSchema)
}

export function purgeThread(threadId: string) {
  return requestControl<{ purged: boolean; threadId: string }>('thread:trash:purge', { threadId })
}

export function listLayers(sessionId?: string | null, threadId?: string | null) {
  return requestControl<LayerDescriptor[]>('layer:list', { sessionId, threadId }, arraySchema(layerDescriptorSchema))
}

export function updateLayer(layerKey: string, payload: Record<string, unknown>) {
  return requestControl<LayerDescriptor>('layer:update', { layerKey, update: payload }, layerDescriptorSchema)
}

export function deleteLayer(layerKey: string) {
  return requestControl<{ deleted: boolean; layerKey: string }>('layer:delete', { layerKey })
}

export function listBasemaps() {
  return requestJson<BasemapDescriptor[]>('/api/v1/map/basemaps', undefined, 30_000, arraySchema(basemapDescriptorSchema))
}

export function listProviders() {
  return requestControl<ModelProviderDescriptor[]>('provider:list', {}, arraySchema(modelProviderDescriptorSchema))
}

export function getSystemComponents() {
  return requestControl<SystemComponentsStatus>('system:get', {}, systemComponentsStatusSchema)
}

export function getSpeechAuthorization() {
  return requestControl<SpeechAuthorization>('speech:authorization', {}, speechAuthorizationSchema)
}

export function listTools() {
  return requestControl<ToolDescriptor[]>('tool:list', {}, arraySchema(toolDescriptorSchema))
}

export function listToolCatalogEntries() {
  return requestControl<Array<Record<string, unknown>>>('tool-catalog:list')
}

export function getRuntimeConfig() {
  // runtime config 来自后端持久化配置，而不是前端硬编码默认值。
  return requestControl<AgentRuntimeConfig>('runtime-config:get', {}, agentRuntimeConfigSchema)
}

export function updateRuntimeConfig(payload: AgentRuntimeConfig) {
  // 调试页保存配置后，前后端都应立即切到同一份结构化配置。
  return requestControl<AgentRuntimeConfig>('runtime-config:update', { config: payload }, agentRuntimeConfigSchema)
}

export function upsertToolCatalogEntry(toolKind: string, toolName: string, payload: Record<string, unknown>, sortOrder?: number) {
  return requestControl<Record<string, unknown>>('tool-catalog:upsert', { toolKind, toolName, payload, sortOrder })
}

export function deleteToolCatalogEntry(toolKind: string, toolName: string) {
  return requestControl<Record<string, unknown>>('tool-catalog:delete', { toolKind, toolName })
}

export function startAnalysis(sessionId: string, query: string, provider?: string, model?: string, executionMode: AgentExecutionMode = 'auto') {
  // 新任务直接创建 v2 run；已有 thread 的续跑走 startThreadRun。
  return requestControl<AnalysisRun>('run:start', { sessionId, query, provider, modelName: model, executionMode }, analysisRunSchema)
}

export function startThreadRun(threadId: string, query: string, provider?: string, model?: string, executionMode: AgentExecutionMode = 'auto') {
  // v2 明确把”线程”和”运行”拆开，便于任务历史与上下文管理。
  return requestControl<AnalysisRun>('run:start', { threadId, query, provider, modelName: model, executionMode }, analysisRunSchema)
}

export function getRun(runId: string) {
  // 首页和 WebSocket 断线恢复都依赖这条命令回收最终快照。
  return requestControl<{ run: AnalysisRun }>('run:get', { runId }).then(snapshot => snapshot.run)
}

export function getThreadRun(runId: string) {
  return getRun(runId)
}

export function getRunEvents(runId: string) {
  return requestControl<{ events: RunEvent[] }>('run:get', { runId }).then(snapshot => snapshot.events)
}

export function getRunItems(runId: string) {
  return requestControl<{ items: ConversationItem[] }>('run:get', { runId }).then(snapshot => snapshot.items)
}

export function getArtifactGeoJson(artifactId: string) {
  return requestJson<GeoJSON.FeatureCollection>(`/api/v1/results/${artifactId}/geojson`)
}

export function getArtifactMetadata(artifactId: string) {
  return requestJson<Record<string, unknown>>(`/api/v1/results/${artifactId}/metadata`)
}

export function respondDecision(runId: string, decisionId: string, optionId?: string | null, text?: string | null) {
  // 用户决策统一走同一条控制命令；后端按 decision.kind 映射到审批恢复或澄清续跑。
  return requestControl<AnalysisRun>('run:respond-decision', { runId, decisionId, optionId, text }, analysisRunSchema)
}

export function cancelRun(runId: string) {
  // 中断当前后台 run。后端会取消对应 asyncio task 并回写 cancelled 快照。
  return requestControl<AnalysisRun>('run:cancel', { runId }, analysisRunSchema)
}

export function runTool(payload: Record<string, unknown>) {
  return requestControl<Record<string, unknown>>('tool:run', payload)
}

export async function uploadLayer(sessionId: string, file: File, threadId?: string | null, sourceRelativePath?: string | null) {
  // 图层上传走 FormData，避免手动处理二进制序列化。
  const formData = new FormData()
  formData.append('session_id', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  if (sourceRelativePath) {
    formData.append('sourceRelativePath', sourceRelativePath)
  }
  formData.append('file', file)

  return requestFormJson<LayerDescriptor>('/api/v1/layers/register', formData, '图层上传请求失败')
}

export async function uploadMeteorologicalDataset(sessionId: string, file: File, threadId?: string | null, sourceRelativePath?: string | null) {
  // 气象数据上传只写 meteorology 数据面；后端负责把 datasetId 与 runtime 文件对象关联。
  const formData = new FormData()
  formData.append('sessionId', sessionId)
  if (threadId) {
    formData.append('threadId', threadId)
  }
  if (sourceRelativePath) {
    formData.append('sourceRelativePath', sourceRelativePath)
  }
  formData.append('file', file)

  return requestFormJson<{ dataset: MeteorologicalDatasetRecord; job: MeteorologicalJobRecord | null }>(
    '/api/v1/meteorology/datasets',
    formData,
    '气象数据上传请求失败',
    600_000,
  )
}

export function listMeteorologicalDatasets(sessionId?: string | null, threadId?: string | null) {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  if (threadId) params.set('threadId', threadId)
  const query = params.toString()
  return requestJson<MeteorologicalDatasetRecord[]>(
    `/api/v1/meteorology/datasets${query ? `?${query}` : ''}`,
    undefined,
    30_000,
    arraySchema(meteorologicalDatasetRecordSchema),
  )
}

export function getMeteorologicalJob(jobId: string) {
  return requestJson<MeteorologicalJobRecord>(
    `/api/v1/meteorology/jobs/${encodeURIComponent(jobId)}`,
    undefined,
    30_000,
    meteorologicalJobRecordSchema,
  )
}


export async function importManagedLayer(
  file: File,
  options?: {
    name?: string
    description?: string
    category?: string
    tags?: string[]
    status?: string
    analysisCapabilities?: string[]
    sourceConfigSummary?: string
  },
) {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.name) {
    formData.append('name', options.name)
  }
  if (options?.description) {
    formData.append('description', options.description)
  }
  if (options?.category) {
    formData.append('category', options.category)
  }
  if (options?.tags?.length) {
    formData.append('tags', options.tags.join(','))
  }
  if (options?.status) {
    formData.append('status', options.status)
  }
  if (options?.analysisCapabilities?.length) {
    formData.append('analysisCapabilities', options.analysisCapabilities.join(','))
  }
  if (options?.sourceConfigSummary) {
    formData.append('sourceConfigSummary', options.sourceConfigSummary)
  }

  return requestFormJson<LayerDescriptor>('/api/v1/layers/import', formData, '后台图层导入请求失败')
}

export async function replaceManagedLayer(layerKey: string, file: File) {
  const formData = new FormData()
  formData.append('file', file)

  return requestFormJson<LayerDescriptor>(
    `/api/v1/layers/${encodeURIComponent(layerKey)}/replace`,
    formData,
    '图层数据替换请求失败',
  )
}

// ---- 统一文件管理 API ----

export interface FileEntry {
  id: string; name: string; size: string; sizeBytes: number
  uploadedAt: string; status: string
  threadId?: string | null
  relativePath?: string
  sourceRelativePath?: string | null
}

export function resumeRun(runId: string) {
  return requestControl<AnalysisRun>('run:resume', { runId }, analysisRunSchema)
}

export interface FileListResponse {
  files: FileEntry[]; total: number
}

export function listAllFiles(threadId?: string | null) {
  return requestControl<FileListResponse>('file:list', { threadId })
}

export async function uploadAnyFile(file: File, threadId?: string | null, requestId?: string, sourceRelativePath?: string | null) {
  const form = new FormData()
  form.append('file', file)
  if (threadId) form.append('threadId', threadId)
  if (requestId) form.append('requestId', requestId)
  if (sourceRelativePath) form.append('sourceRelativePath', sourceRelativePath)
  return requestFormJson<{ id: string; name: string; size: string; sizeBytes: number; sourceRelativePath?: string | null }>(
    '/api/v1/files/upload',
    form,
    '文件上传请求失败',
    600_000,
  )
}

export function deleteAnyFile(fileId: string, threadId?: string | null) {
  return requestControl<{ deleted: boolean; id: string }>('file:delete', { fileId, threadId })
}

export function subscribeRun(runId: string) {
  return requestControl<{ run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }>('run:subscribe', { runId }, subscribeRunResponseSchema)
}

export function unsubscribeRun(runId: string) {
  return requestControl<{ unsubscribed: boolean; runId: string }>('run:unsubscribe', { runId })
}
