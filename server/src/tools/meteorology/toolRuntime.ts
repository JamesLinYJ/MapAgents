// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具运行时边界
//
//   文件:       toolRuntime.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ToolContext, ToolResult, ValueRef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import type { MeteorologyToolDeps } from './toolDefinition.js'

export const DATASET_SUFFIXES = ['.nc', '.nc4', '.tif', '.tiff', '.grib', '.grb', '.grb2', '.h5', '.hdf5']
export const NETCDF_SUFFIXES = ['.nc', '.nc4']
const RADAR_SUFFIXES = ['.bz2']
const BOUNDARY_SUFFIXES = ['.zip', '.shp', '.geojson', '.json']
export const METEOROLOGICAL_FILE_SUFFIXES = [...DATASET_SUFFIXES, ...RADAR_SUFFIXES, ...BOUNDARY_SUFFIXES]
export const RADAR_PRODUCTS = ['reflectivity', 'velocity', 'spectrum_width', 'zdr', 'cc', 'dp', 'kdp', 'snrh', 'echo_top']
export const BOUNDARY_REF_KINDS = ['meteorological_file', 'feature_collection', 'nowcast_area', 'layer']

const THIRD_PARTY_SOURCE_SNAPSHOTS = {
  radar_mosaic_agent: 'packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/source/original',
  rainfall_risk_map: 'packages/gis-meteorology/src/gis_meteorology/third_party/rainfall_risk_map/source/original',
  short_term_forecast: 'packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/original',
} as const
const THIRD_PARTY_WRAPPER_VERSION = 'geoforge-wrapper-2026-06-23'

export function result(
  name: string,
  message: string,
  payload: Record<string, unknown>,
  valueRefs: ValueRef[],
  artifacts: MeteorologicalArtifactTarget[] = [],
  provenance: Record<string, unknown> = {},
): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: `gis_meteorology.${name}`,
    valueRefs,
    artifacts,
    provenance: { backend: 'gis_meteorology', ...provenance },
  }
}

export function resultRefs(name: string, label: string, payload: Record<string, unknown>): ValueRef[] {
  const refs: ValueRef[] = [{ refId: makeId('ref'), kind: `${name}_result`, label, value: payload }]
  if (name === 'meteorological_stats') {
    for (const key of ['min', 'mean', 'median', 'p50', 'p90', 'max']) {
      const value = payload[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      refs.push({ refId: makeId('ref'), kind: 'meteorological_threshold', label: `${label} / ${key}`, value, unit: typeof payload.unit === 'string' ? payload.unit : null })
    }
    const levels = ['min', 'p50', 'p90', 'max']
      .map(key => payload[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (levels.length >= 2) refs.push({ refId: makeId('ref'), kind: 'meteorological_contour_levels', label: `${label} / 等值线层级`, value: [...new Set(levels)] })
  }
  return refs
}

function requiredRef(ctx: ToolContext, args: Record<string, unknown>, key: string): ValueRef {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) throw new Error(`${key} 不能为空`)
  return ctx.resolveValueRef(refId)
}

export function requiredRefKind(ctx: ToolContext, args: Record<string, unknown>, key: string, kinds: string[]): ValueRef {
  const ref = requiredRef(ctx, args, key)
  if (!kinds.includes(ref.kind)) throw new Error(`${key} 必须引用 ${kinds.join(' 或 ')}，实际为 ${ref.kind}`)
  return ref
}

export function optionalRefValue(ctx: ToolContext, args: Record<string, unknown>, key: string, field?: string): unknown {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) return undefined
  const value = ctx.resolveValueRef(refId).value
  if (!field) return value
  const record = refObject(value)
  return record[field]
}

export async function datasetFileFromArgs(
  ctx: ToolContext,
  args: Record<string, unknown>,
  refKey: string,
  allowedKinds: string[],
): Promise<{ name: string; relativePath: string }> {
  const refId = typeof args[refKey] === 'string' ? String(args[refKey]).trim() : ''
  if (refId && refId !== 'latest_upload') {
    return datasetValue(ctx, requiredRefKind(ctx, args, refKey, allowedKinds))
  }

  const datasetId = typeof args.dataset_id === 'string' && args.dataset_id.trim()
    ? args.dataset_id.trim()
    : refId === 'latest_upload' ? 'latest_upload' : null
  const filename = typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : null
  if (!ctx.resolveMeteorologicalDataset) {
    throw new Error('当前运行上下文不支持解析气象数据集')
  }
  const dataset = await ctx.resolveMeteorologicalDataset({ datasetId, filename })
  if (!dataset) {
    throw new Error('当前 thread 没有可用的气象数据集；请先上传 NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 文件。')
  }
  return { name: dataset.filename, relativePath: dataset.fileRelativePath }
}

export function datasetValue(ctx: ToolContext, ref: ValueRef): { name: string; relativePath: string } {
  const value = refObject(ref.value)
  const relativePath = typeof value.relativePath === 'string'
    ? value.relativePath
    : typeof value.datasetRelativePath === 'string' ? value.datasetRelativePath : ''
  if (!relativePath) throw new Error(`引用 "${ref.refId}" 不包含数据文件路径`)
  return { name: typeof value.name === 'string' ? value.name : ref.label, relativePath }
}

type MeteorologicalArtifactExt = 'png' | 'geojson' | 'docx' | 'xlsx' | 'npz'

export type MeteorologicalArtifactTarget = ReturnType<typeof artifactTarget>

export function artifactTarget(ctx: ToolContext, artifactType: MeteorologicalArtifactExt, name: string) {
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.${artifactType}`)
  return {
    artifactId, artifactType: artifactKind(artifactType), name,
    uri: `/api/v1/results/${artifactId}/${artifactType === 'geojson' ? 'geojson' : 'file'}`,
    relativePath,
    metadata: { relativePath },
  }
}

function artifactKind(ext: MeteorologicalArtifactExt): string {
  if (ext === 'png') return 'raster_png'
  return ext
}

export function thirdPartyProvenance(
  source: keyof typeof THIRD_PARTY_SOURCE_SNAPSHOTS,
  inputRefs: Record<string, unknown>,
  artifacts: MeteorologicalArtifactTarget[] = [],
): Record<string, unknown> {
  return {
    thirdPartySource: source,
    sourceSnapshot: THIRD_PARTY_SOURCE_SNAPSHOTS[source],
    wrapperVersion: THIRD_PARTY_WRAPPER_VERSION,
    inputRefs,
    outputArtifacts: artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      relativePath: artifact.relativePath,
    })),
  }
}

export function mergeArtifactMetadata(
  artifact: MeteorologicalArtifactTarget,
  payload: Record<string, unknown>,
): void {
  artifact.metadata = { ...payload, relativePath: artifact.relativePath }
}

export async function writeJsonArtifact(deps: MeteorologyToolDeps, relativePath: string, payload: Record<string, unknown>): Promise<void> {
  await writeRuntimeJson(deps, relativePath, payload)
}

async function writeRuntimeJson(deps: MeteorologyToolDeps, relativePath: string, payload: unknown): Promise<void> {
  const root = path.resolve(deps.runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(payload), 'utf8')
}

export function inputKind(name: string): 'dataset' | 'radar' | 'boundary' {
  const lower = name.toLowerCase()
  if (RADAR_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'radar'
  if (BOUNDARY_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'boundary'
  return 'dataset'
}

export function collectionFiles(collection: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const files = collection.files
  if (!Array.isArray(files) || !files.length || !files.every(isRecord)) {
    throw new Error(`${key} 不包含文件集合`)
  }
  return files
}

export function uploadSourceKey(entry: { name: string; sourceRelativePath?: string | null }): string {
  return entry.sourceRelativePath || entry.name
}

export function sequenceFiles(sequence: Record<string, unknown>): Record<string, unknown>[] {
  const datasets = sequence.datasets
  if (!Array.isArray(datasets) || !datasets.length || !datasets.every(isRecord)) {
    throw new Error('nowcast_sequence 不包含 datasets')
  }
  return datasets.map((item, index) => {
    const relativePath = typeof item.relativePath === 'string' ? item.relativePath : ''
    if (!relativePath) throw new Error(`nowcast_sequence.datasets[${index}] 缺少 relativePath`)
    return {
      fileId: typeof item.datasetId === 'string' ? item.datasetId : `dataset_${index + 1}`,
      name: typeof item.filename === 'string' ? item.filename : path.posix.basename(relativePath),
      relativePath,
    }
  })
}

export function assertSuffix(filename: string, suffixes: string[], label: string): void {
  const lower = filename.toLowerCase()
  if (!suffixes.some(suffix => lower.endsWith(suffix))) {
    throw new Error(`${label} 文件类型不受支持: ${filename}`)
  }
}

export function assertFileObjectsSuffix(files: Record<string, unknown>[], suffixes: string[], label: string): void {
  for (const [index, file] of files.entries()) {
    const name = typeof file.name === 'string' ? file.name : typeof file.filename === 'string' ? file.filename : ''
    if (!name) throw new Error(`${label} 文件集合第 ${index + 1} 项缺少 name`)
    assertSuffix(name, suffixes, label)
  }
}

export async function boundaryInputRelativePath(ctx: ToolContext, args: Record<string, unknown>, key: string, deps: MeteorologyToolDeps): Promise<string> {
  const ref = requiredRefKind(ctx, args, key, BOUNDARY_REF_KINDS)
  if (ref.kind === 'meteorological_file') {
    const file = datasetValue(ctx, ref)
    assertSuffix(file.name, BOUNDARY_SUFFIXES, '边界')
    return file.relativePath
  }
  const payload = featureCollectionFromBoundaryRef(ref, key)
  const relativePath = path.posix.join('artifacts', ctx.runId, `${makeId('boundary')}.geojson`)
  await writeRuntimeJson(deps, relativePath, payload)
  return relativePath
}

type FeatureCollectionRecord = Record<string, unknown> & { type: 'FeatureCollection'; features: unknown[] }

export function featureCollectionFromBoundaryRef(ref: ValueRef, key: string): FeatureCollectionRecord {
  const payload = ref.kind === 'layer' ? refObject(ref.value).featureCollection : ref.value
  if (!isFeatureCollectionRecord(payload)) {
    if (ref.kind === 'layer') {
      throw new Error(`${key} 的 layer 引用缺少 featureCollection，请先使用 query_layer 生成 feature_collection 引用`)
    }
    throw new Error(`${key} 必须是 FeatureCollection、layer 或边界文件引用`)
  }
  return payload
}

function isFeatureCollectionRecord(value: unknown): value is FeatureCollectionRecord {
  return isRecord(value) && value.type === 'FeatureCollection' && Array.isArray(value.features)
}

export function coordinateFromRef(ref: ValueRef): { lat: number; lng: number; label: string } {
  const payload = refObject(ref.value)
  const lat = Number(payload.lat)
  const lng = Number(payload.lng ?? payload.lon)
  const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : ref.label
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`scope_ref '${ref.refId}' 不包含有效经纬度`)
  }
  return { lat, lng, label }
}

export function normalizeThresholds(value: unknown): Array<{ label: string; min: number; max: number; color: string }> {
  const raw = value === undefined || value === null ? defaultRainfallThresholds() : value
  const parsed = typeof raw === 'string' ? parseJson(raw, 'thresholds') : raw
  const array = isRecord(parsed) && Array.isArray(parsed.thresholds) ? parsed.thresholds : parsed
  if (!Array.isArray(array)) throw new Error('thresholds 必须是数组或包含 thresholds 数组的对象')
  const thresholds = array.map((item, index) => {
    if (!isRecord(item)) throw new Error(`thresholds[${index}] 必须是对象`)
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const min = Number(item.min)
    const max = Number(item.max)
    const color = typeof item.color === 'string' ? item.color.trim() : ''
    if (!label || !Number.isFinite(min) || !Number.isFinite(max) || max <= min || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new Error(`thresholds[${index}] 必须包含 label、递增 min/max 和 #RRGGBB color`)
    }
    return { label, min, max, color }
  }).sort((a, b) => a.min - b.min)
  if (!thresholds.length) throw new Error('thresholds 不能为空')
  return thresholds
}

export function defaultRainfallThresholds() {
  return [
    { label: '无雨/小雨', min: 0, max: 1.5, color: '#f0f0f0' },
    { label: '短时大雨', min: 1.5, max: 3, color: '#a6d96a' },
    { label: '短时暴雨', min: 3, max: 5, color: '#1a9850' },
    { label: '短时大暴雨', min: 5, max: 8, color: '#fdae61' },
    { label: '短时大暴雨~特大暴雨', min: 8, max: 12, color: '#d73027' },
    { label: '短时特大暴雨', min: 12, max: 999, color: '#7a0177' },
  ]
}

export function rainfallThresholdsSchema(): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'min', 'max', 'color'],
      properties: {
        label: { type: 'string', minLength: 1 },
        min: { type: 'number' },
        max: { type: 'number' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      },
    },
  }
}

export function areaRainfallStyleSchema(): Record<string, unknown> {
  const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      titleText: { type: 'string', minLength: 1 },
      titleColor: color,
      headerBg: color,
      headerColor: color,
      top3Bg: color,
      borderColor: color,
      dataColor: color,
      bgColor: color,
    },
  }
}

export function defaultAreaRainfallStyle(): Record<string, string> {
  return {
    titleText: '区域累计面雨量排行',
    titleColor: '#2E72D6',
    headerBg: '#E8F0FA',
    headerColor: '#333333',
    top3Bg: '#FFF2CC',
    borderColor: '#D0D0D0',
    dataColor: '#333333',
    bgColor: '#FFFFFF',
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} 不是合法 JSON`)
  }
}

export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

export function selectNowcastMapCandidate(analysis: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(analysis.mapCandidates) ? analysis.mapCandidates.filter(isRecord) : []
  if (!candidates.length) throw new Error('短时临近预报（短临）分析没有可渲染的地图候选时次')
  return candidates.find(candidate => candidate.reason === '降雨峰值时次') ?? candidates[0]
}

export function requiredCandidateText(candidate: Record<string, unknown>, key: string): string {
  const value = candidate[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`短时临近预报（短临）地图候选缺少 ${key}`)
  return value.trim()
}

export function nowcastRenderBbox(analysis: Record<string, unknown>): unknown {
  const scope = isRecord(analysis.scope) ? analysis.scope : null
  return scope && Array.isArray(scope.renderBbox) ? scope.renderBbox : undefined
}

export function refObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('valueRef 的值必须是对象')
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
