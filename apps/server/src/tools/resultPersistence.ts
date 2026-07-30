// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化
//
//   文件:       resultPersistence.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// Agent 自动调用与 Debug 工作台直跑必须共享同一条结果持久化路径。
// run state 是实时快照，分片 run 文件是历史事实源，Postgres 只保存 artifact 可重建索引。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult, ValueRef } from '../framework/types.js'
import type { ArtifactRef, ClarificationState, DecisionRequest, AgentWorkflow, TodoItem, ToolValueRef } from '../schemas/types.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { createAgentWorkflow, reviseAgentWorkflow } from '../agent/agentWorkflowState.js'

export async function persistToolExecutionResult(
  store: ToolExecutionStore,
  runId: string,
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  const refs: ToolValueRef[] = (result.valueRefs ?? []).map(ref => ({
    ...ref,
    sourceTool: toolName,
    sourceResultId: result.resultId,
    metadata: ref.metadata ?? {},
    createdAt: nowUtc(),
    unit: ref.unit ?? null,
  }))
  const explicitArtifacts: ArtifactRef[] = (result.artifacts ?? []).map(artifact => ({
    artifactId: artifact.artifactId,
    runId,
    artifactType: artifact.artifactType,
    name: artifact.name,
    uri: artifact.uri,
    display: artifact.display,
    metadata: { ...(artifact.metadata ?? {}), ...(artifact.relativePath ? { relativePath: artifact.relativePath } : {}) },
    isIntermediate: false,
  }))
  const generatedArtifacts = await createGeoArtifacts(result, runId, store.runtimeRoot)
  const artifacts = dedupeArtifacts([...explicitArtifacts, ...generatedArtifacts])
  await store.mutateRunState(runId, state => ({
    toolValueRefs: dedupeValueRefs([...state.toolValueRefs, ...refs]),
    artifacts: dedupeArtifacts([...state.artifacts, ...artifacts]),
    ...agentWorkflowControlState(result.payload, state.agentWorkflow, state.todos),
    ...clarificationControlState(result.payload, state.decisions),
    ...todoControlState(result.payload),
    toolResults: [...state.toolResults, {
      stepId: makeId('step'),
      tool: toolName,
      toolLabel,
      args,
      status: 'completed',
      message: result.message,
      startedAt: null,
      completedAt: nowUtc(),
      resultId: result.resultId,
      source: result.source,
      confidence: null,
      usedQuery: null,
      provenance: result.provenance ?? {},
      crs: {},
      geometryType: null,
      featureCount: null,
      valueRefs: refs,
    }],
  }))
  // value 与 Artifact 元数据写入 PostgreSQL 事实源。按结果声明顺序持久化，
  // 避免 Promise.all 让同一次工具调用的记录顺序依赖调度时机。
  for (const ref of refs) await store.appendToolValue(runId, ref)
  for (const artifact of artifacts) await store.persistArtifact(artifact)
}

// 智能体工作流由系统工具提交或修订。结构和依赖图在领域状态机中验证，
// 不允许持久化层用缺省值修补模型生成的无效计划。
function agentWorkflowControlState(
  payload: Record<string, unknown>,
  current: AgentWorkflow | null,
  currentTodos: TodoItem[],
): Partial<{
  planMode: boolean
  agentWorkflow: AgentWorkflow
  todos: TodoItem[]
}> {
  const updates: Partial<{ planMode: boolean; agentWorkflow: AgentWorkflow; todos: TodoItem[] }> = {}
  if (typeof payload.planMode === 'boolean') updates.planMode = payload.planMode
  if (isRecord(payload.agentWorkflowDraft)) {
    const workflow = createAgentWorkflow(payload.agentWorkflowDraft)
    updates.agentWorkflow = workflow
    updates.todos = projectWorkflowTodos(workflow, currentTodos)
  }
  if (isRecord(payload.agentWorkflowRevision)) {
    if (!current) throw new Error('当前运行没有可以调整的智能体工作流。')
    const workflow = reviseAgentWorkflow(current, payload.agentWorkflowRevision)
    updates.agentWorkflow = workflow
    updates.todos = projectWorkflowTodos(workflow, currentTodos)
  }
  return updates
}

function projectWorkflowTodos(workflow: AgentWorkflow, currentTodos: TodoItem[]): TodoItem[] {
  const existingByStep = new Map(currentTodos
    .filter(todo => todo.stepId)
    .map(todo => [todo.stepId as string, todo]))
  const independentTodos = currentTodos.filter(todo => !todo.stepId)
  const workflowTodos = workflow.steps.map(step => {
    const existing = existingByStep.get(step.stepId)
    return {
      todoId: existing?.todoId ?? makeId('todo'),
      title: step.title,
      status: step.status === 'skipped' ? 'completed' as const : step.status,
      description: step.reason,
      activeForm: step.status === 'running' ? `正在${step.title}` : null,
      ownerAgentId: step.ownerAgentId,
      stepId: step.stepId,
    }
  })
  return [...independentTodos, ...workflowTodos]
}

// 澄清是单次 run 的显式终止原因，不等于退出计划模式。
// 工具把结构化问题写入这里，UI/SSE 不再从 assistant 正文里猜测澄清状态。
function clarificationControlState(
  payload: Record<string, unknown>,
  currentDecisions: DecisionRequest[],
): Partial<{ clarification: ClarificationState | null; decisions: DecisionRequest[] }> {
  if (!isRecord(payload.clarification)) return {}
  const raw = payload.clarification
  const options = Array.isArray(raw.options)
    ? raw.options.filter(isRecord).map((option, index) => ({
      optionId: typeof option.optionId === 'string' ? option.optionId : `clarification_option_${index + 1}`,
      label: typeof option.label === 'string' && option.label.trim() ? option.label.trim() : `选项 ${index + 1}`,
      description: typeof option.description === 'string' ? option.description : '',
      kind: typeof option.kind === 'string' ? option.kind : 'generic',
      reason: typeof option.reason === 'string' ? option.reason : null,
      payload: isRecord(option.payload) ? option.payload : {},
    }))
    : []
  const clarification: ClarificationState = {
    clarificationId: typeof raw.clarificationId === 'string' && raw.clarificationId.trim()
      ? raw.clarificationId.trim()
      : makeId('clarification'),
    kind: typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : 'generic',
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'generic',
    question: typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : '请补充必要信息。',
    options,
    selectedOptionId: typeof raw.selectedOptionId === 'string' ? raw.selectedOptionId : null,
    allowFreeText: typeof raw.allowFreeText === 'boolean' ? raw.allowFreeText : true,
  }
  const decision: DecisionRequest = {
    decisionId: clarification.clarificationId,
    kind: 'clarification',
    title: '需要补充信息',
    question: clarification.question,
    description: clarification.reason,
    options: clarification.options,
    allowFreeText: clarification.allowFreeText,
    status: 'pending',
    payload: {
      clarificationId: clarification.clarificationId,
      clarificationKind: clarification.kind,
      reason: clarification.reason,
    },
    createdAt: nowUtc(),
    resolvedAt: null,
  }
  return { clarification, decisions: upsertDecision(currentDecisions, decision) }
}

function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  const next = decisions.filter(item => item.decisionId !== decision.decisionId)
  return [...next, decision]
}

// todo_write 的 payload 是运行状态更新，不是普通文本结果。统一在工具持久化
// 入口写回 AgentState，确保时间线、右侧结果和 DebugPage 看到同一份 Todo。
function todoControlState(payload: Record<string, unknown>): Partial<{ todos: TodoItem[] }> {
  if (!Array.isArray(payload.todos)) return {}
  return { todos: payload.todos.map((todo, index) => normalizeTodoItem(todo, index)) }
}

function normalizeTodoItem(value: unknown, index: number): TodoItem {
  const raw = isRecord(value) ? value : {}
  const status = typeof raw.status === 'string' && ['pending', 'running', 'completed', 'failed', 'blocked'].includes(raw.status)
    ? raw.status as TodoItem['status']
    : 'pending'
  return {
    todoId: typeof raw.todoId === 'string' && raw.todoId.trim() ? raw.todoId.trim() : `todo_${index + 1}`,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Todo ${index + 1}`,
    status,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null,
    activeForm: typeof raw.activeForm === 'string' && raw.activeForm.trim() ? raw.activeForm.trim() : null,
    ownerAgentId: typeof raw.ownerAgentId === 'string' && raw.ownerAgentId.trim() ? raw.ownerAgentId.trim() : null,
    stepId: typeof raw.stepId === 'string' && raw.stepId.trim() ? raw.stepId.trim() : null,
  }
}

export function resolveRuntimeValueRef(state: Map<string, unknown>, refId: string): ValueRef {
  const value = state.get(refId)
  if (!isRecord(value) || typeof value.refId !== 'string') throw new Error(`未知 valueRef：${refId}`)
  return value as unknown as ValueRef
}

async function createGeoArtifacts(result: ToolResult, runId: string, runtimeRoot: string): Promise<ArtifactRef[]> {
  const artifacts: ArtifactRef[] = []
  const serialized = new Set<string>()
  for (const ref of result.valueRefs ?? []) {
    const geojson = extractGeoJson(ref.value, ref.kind)
    if (!geojson) continue
    const artifact = await writeGeoArtifact(runtimeRoot, runId, ref.label || result.message, ref.kind, geojson, serialized)
    if (artifact) artifacts.push(artifact)
  }
  for (const [key, value] of Object.entries(result.payload)) {
    const geojson = extractGeoJson(value)
    if (!geojson) continue
    const artifact = await writeGeoArtifact(runtimeRoot, runId, key === 'route' ? '规划路线' : key, key, geojson, serialized)
    if (artifact) artifacts.push(artifact)
  }
  return artifacts
}

async function writeGeoArtifact(
  runtimeRoot: string,
  runId: string,
  name: string,
  kind: string,
  geojson: Record<string, unknown>,
  serialized: Set<string>,
): Promise<ArtifactRef | null> {
  const content = JSON.stringify(geojson)
  if (serialized.has(content)) return null
  serialized.add(content)
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', runId, `${artifactId}.geojson`)
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return {
    artifactId,
    runId,
    artifactType: 'geojson',
    name,
    uri: `/api/v1/results/${artifactId}/geojson`,
    display: {
      surfaces: ['map', 'download'],
      primarySurface: 'map',
      map: {
        title: name,
        replacementGroup: null,
        bounds: requireGeoJsonBounds(geojson),
        crs: 'EPSG:4326',
        minZoom: 0,
        maxZoom: 22,
        source: {
          kind: 'geojson',
          url: `/api/v1/results/${artifactId}/geojson`,
          featureCount: countGeoJsonFeatures(geojson),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
        style: defaultGeoJsonStyle(geojson),
        legend: null,
        temporal: null,
        capabilities: {
          query: true,
          labels: true,
          style: true,
          temporal: false,
          opacity: true,
          download: true,
        },
      },
    },
    metadata: { relativePath, kind },
    isIntermediate: false,
  }
}

function requireGeoJsonBounds(geojson: Record<string, unknown>): [number, number, number, number] {
  const coordinates: Array<[number, number]> = []
  collectGeoJsonCoordinates(geojson, coordinates)
  if (!coordinates.length) throw new Error('GeoJSON Artifact 没有可制图坐标')
  const longitudes = coordinates.map(([longitude]) => longitude)
  const latitudes = coordinates.map(([, latitude]) => latitude)
  const west = Math.min(...longitudes)
  const east = Math.max(...longitudes)
  const south = Math.min(...latitudes)
  const north = Math.max(...latitudes)
  if (west === east || south === north) {
    const longitudePadding = west === east ? 0.0001 : 0
    const latitudePadding = south === north ? 0.0001 : 0
    return [west - longitudePadding, south - latitudePadding, east + longitudePadding, north + latitudePadding]
  }
  return [west, south, east, north]
}

function collectGeoJsonCoordinates(value: unknown, output: Array<[number, number]>): void {
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      if (Number.isFinite(value[0]) && Number.isFinite(value[1])) output.push([value[0], value[1]])
      return
    }
    for (const child of value) collectGeoJsonCoordinates(child, output)
    return
  }
  if (!isRecord(value)) return
  if ('coordinates' in value) collectGeoJsonCoordinates(value.coordinates, output)
  if (Array.isArray(value.features)) collectGeoJsonCoordinates(value.features, output)
  if ('geometry' in value) collectGeoJsonCoordinates(value.geometry, output)
  if (Array.isArray(value.geometries)) collectGeoJsonCoordinates(value.geometries, output)
}

function countGeoJsonFeatures(geojson: Record<string, unknown>): number {
  if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) return geojson.features.length
  return 1
}

function defaultGeoJsonStyle(geojson: Record<string, unknown>) {
  const geometryTypes = new Set<string>()
  collectGeoJsonGeometryTypes(geojson, geometryTypes)
  if ([...geometryTypes].some(type => type.includes('Polygon'))) {
    return {
      kind: 'polygon' as const,
      color: '#2563eb',
      opacity: 0.55,
      colorField: null,
      categories: [],
      outlineColor: '#1d4ed8',
      outlineWidth: 1,
    }
  }
  if ([...geometryTypes].some(type => type.includes('LineString'))) {
    return {
      kind: 'line' as const,
      color: '#2563eb',
      opacity: 0.9,
      colorField: null,
      categories: [],
      width: 2,
      dashArray: null,
    }
  }
  return {
    kind: 'point' as const,
    color: '#2563eb',
    opacity: 0.9,
    colorField: null,
    categories: [],
    radius: 6,
    strokeColor: '#ffffff',
    strokeWidth: 1,
    cluster: false,
  }
}

function collectGeoJsonGeometryTypes(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectGeoJsonGeometryTypes(child, output)
    return
  }
  if (!isRecord(value)) return
  if (typeof value.type === 'string' && value.type !== 'Feature' && value.type !== 'FeatureCollection') output.add(value.type)
  if (Array.isArray(value.features)) collectGeoJsonGeometryTypes(value.features, output)
  if ('geometry' in value) collectGeoJsonGeometryTypes(value.geometry, output)
  if (Array.isArray(value.geometries)) collectGeoJsonGeometryTypes(value.geometries, output)
}

function extractGeoJson(value: unknown, kind?: string): Record<string, unknown> | null {
  if (kind && !['geojson', 'route', 'feature_collection'].includes(kind)) return null
  return isGeoJsonObject(value) ? value : null
}

function isGeoJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [
    'FeatureCollection', 'Feature', 'LineString', 'Point', 'Polygon',
    'MultiLineString', 'MultiPoint', 'MultiPolygon', 'GeometryCollection',
  ].includes(String(value.type))
}

function dedupeArtifacts<T extends ArtifactRef>(artifacts: T[]): T[] {
  return [...new Map(artifacts.map(artifact => [artifact.artifactId, artifact])).values()]
}

function dedupeValueRefs<T extends ToolValueRef>(refs: T[]): T[] {
  return [...new Map(refs.map(ref => [ref.refId, ref])).values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
