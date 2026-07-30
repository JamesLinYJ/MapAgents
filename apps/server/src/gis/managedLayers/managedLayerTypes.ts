// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 托管图层领域类型
//
//   文件:       managedLayerTypes.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { LayerPropertyDescriptor, ResourceVisibility } from '../../schemas/types.js'
import type { GeoJsonFeature, GeoJsonFeatureCollection, Geometry } from '../geojson.js'

export type LayerBounds = [number, number, number, number]

export type LayerPropertyValue = string | number | boolean

export interface LayerPropertyFilter {
  property: string
  values: LayerPropertyValue[]
}

export interface LayerFeatureQuery {
  bbox?: LayerBounds
  propertyFilter?: LayerPropertyFilter
  limit?: number
}

export interface StoredFeature {
  geometry: Geometry
  properties: Record<string, unknown>
}

export interface ImportGeoJsonLayerInput {
  collection: GeoJsonFeatureCollection
  layerKey?: string | null
  name: string
  sourceType: string
  description?: string | null
  tags?: string[]
  category?: string | null
  status?: string | null
  sourceFilename?: string | null
  sessionId?: string | null
  threadId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  visibility?: ResourceVisibility
  readonly?: boolean
}

export interface LayerMetadataPatch {
  name?: string
  description?: string
  tags?: string[]
  category?: string
  status?: string
  analysisCapabilities?: string[]
  sourceConfigSummary?: string | null
}

export interface ManagedLayerOwnership {
  scope: 'system' | 'workspace' | 'thread'
  workspaceId: string | null
  threadId: string | null
}

export interface PreparedManagedLayerImport {
  input: ImportGeoJsonLayerInput
  features: GeoJsonFeature[]
  layerKey: string
  mapLayerId: string
  ownership: ManagedLayerOwnership
  geometryType: string
  bounds: LayerBounds
  propertySchema: LayerPropertyDescriptor[]
  style: Record<string, unknown>
}
