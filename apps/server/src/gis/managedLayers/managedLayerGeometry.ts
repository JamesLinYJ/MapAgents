// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 托管图层几何准备
//
//   文件:       managedLayerGeometry.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { LayerPropertyDescriptor } from '../../schemas/types.js'
import { makeId } from '../../utils/ids.js'
import type { GeoJsonFeature, Geometry, Position } from '../geojson.js'
import type {
  ImportGeoJsonLayerInput,
  LayerBounds,
  ManagedLayerOwnership,
  PreparedManagedLayerImport,
} from './managedLayerTypes.js'

interface PropertySchemaAccumulator {
  dataType: string
  populatedCount: number
  sampleValues: Set<string>
}

export function prepareManagedLayerImport(input: ImportGeoJsonLayerInput): PreparedManagedLayerImport {
  const features = requireFeatures(input)
  const layerKey = sanitizeLayerKey(input.layerKey ?? makeId('layer'))
  const geometryTypes = [...new Set(features.map(feature => feature.geometry.type))]
  const geometryType = geometryTypes.length === 1 ? geometryTypes[0] ?? 'Mixed' : 'Mixed'
  return {
    input,
    features,
    layerKey,
    mapLayerId: `map_layer_${layerKey}`,
    ownership: resolveOwnership(input),
    geometryType,
    bounds: normalizeBounds(computeBounds(features)),
    propertySchema: buildPropertySchema(features),
    style: defaultVectorStyle(geometryType),
  }
}

function requireFeatures(input: ImportGeoJsonLayerInput): GeoJsonFeature[] {
  const { collection } = input
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('GeoJSON 必须是 FeatureCollection')
  }
  if (collection.features.length === 0) {
    throw new Error('GeoJSON 至少需要一个 feature')
  }
  return collection.features.map((feature, index) => {
    if (feature.type !== 'Feature' || !isGeometry(feature.geometry)) {
      throw new Error(`GeoJSON 第 ${index + 1} 个 feature 缺少有效 geometry`)
    }
    return feature
  })
}

function resolveOwnership(input: ImportGeoJsonLayerInput): ManagedLayerOwnership {
  if (input.sourceType === 'system') return { scope: 'system', workspaceId: null, threadId: null }
  if (!input.workspaceId) throw new Error('非系统图层必须绑定 workspaceId')
  return input.threadId
    ? { scope: 'thread', workspaceId: input.workspaceId, threadId: input.threadId }
    : { scope: 'workspace', workspaceId: input.workspaceId, threadId: null }
}

function isGeometry(value: unknown): value is Geometry {
  return isRecord(value) && typeof value.type === 'string'
    && (value.type === 'GeometryCollection' ? Array.isArray(value.geometries) : 'coordinates' in value)
}

function defaultVectorStyle(geometryType: string): Record<string, unknown> {
  if (geometryType.includes('Point')) {
    return {
      kind: 'point', opacity: 1, colorField: null, categories: [], color: '#1976d2',
      radius: 6, strokeColor: '#ffffff', strokeWidth: 1, cluster: true,
    }
  }
  if (geometryType.includes('Line')) {
    return {
      kind: 'line', opacity: 1, colorField: null, categories: [], color: '#1976d2',
      width: 2, dashArray: null,
    }
  }
  return {
    kind: 'polygon', opacity: 0.72, colorField: null, categories: [], color: '#3aa981',
    outlineColor: '#16735a', outlineWidth: 1,
  }
}

function buildPropertySchema(features: GeoJsonFeature[]): LayerPropertyDescriptor[] {
  const stats = new Map<string, PropertySchemaAccumulator>()
  for (const feature of features) {
    const properties = feature.properties === null
      ? {}
      : requireRecord(feature.properties, 'GeoJSON properties')
    for (const [name, value] of Object.entries(properties)) {
      const current = stats.get(name) ?? {
        dataType: inferDataType(value), populatedCount: 0, sampleValues: new Set<string>(),
      }
      if (value !== null && value !== undefined && value !== '') {
        current.populatedCount += 1
        if (current.sampleValues.size < 5) current.sampleValues.add(String(value))
      }
      if (current.dataType === 'null') current.dataType = inferDataType(value)
      stats.set(name, current)
    }
  }
  return [...stats.entries()].map(([name, entry]) => ({
    name,
    dataType: entry.dataType === 'null' ? 'string' : entry.dataType,
    populatedCount: entry.populatedCount,
    sampleValues: [...entry.sampleValues],
  }))
}

function inferDataType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function normalizeBounds(bounds: LayerBounds | null): LayerBounds {
  if (!bounds) throw new Error('GeoJSON 不包含有效坐标')
  const [west, south, east, north] = bounds
  const lonPadding = west === east ? 0.0001 : 0
  const latPadding = south === north ? 0.0001 : 0
  return [
    Math.max(-180, west - lonPadding),
    Math.max(-90, south - latPadding),
    Math.min(180, east + lonPadding),
    Math.min(90, north + latPadding),
  ]
}

function computeBounds(features: GeoJsonFeature[]): LayerBounds | null {
  const coordinates: Position[] = []
  for (const feature of features) collectCoordinates(feature.geometry, coordinates)
  if (!coordinates.length) return null
  const xs = coordinates.map(coordinate => coordinate[0])
  const ys = coordinates.map(coordinate => coordinate[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function collectCoordinates(geometry: Geometry, output: Position[]): void {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) collectCoordinates(child, output)
    return
  }
  collectPositionArray(geometry.coordinates, output)
}

function collectPositionArray(value: unknown, output: Position[]): void {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    output.push([value[0], value[1]])
    return
  }
  for (const child of value) collectPositionArray(child, output)
}

function sanitizeLayerKey(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]+/gu, '_')
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)
    ? normalized
    : `layer_${normalized || makeId('layer').replace(/^layer_/, '')}`
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
