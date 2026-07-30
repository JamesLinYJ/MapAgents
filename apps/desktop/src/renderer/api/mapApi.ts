// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图数据面 API
//
//   文件:       mapApi.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  mapFeaturePageSchema,
  mapLayerManifestSchema,
  mapSceneSchema,
  mapSceneUpdateSchema,
  type MapSceneUpdate,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'
import { requestControl, requestJson } from './transport'

export const mapSceneBundleSchema = z.object({
  scene: mapSceneSchema.nullable(),
  layers: z.array(mapLayerManifestSchema),
})

export type MapSceneBundle = z.infer<typeof mapSceneBundleSchema>

export function getMapScene(threadId: string): Promise<MapSceneBundle> {
  return requestJson(`/api/v1/map/scenes/${encodeURIComponent(threadId)}`, undefined, 30_000, mapSceneBundleSchema)
}

export function updateMapScene(input: MapSceneUpdate) {
  const payload = mapSceneUpdateSchema.parse(input)
  return requestControl('map-scene:update', payload, mapSceneSchema)
}

export function getMapLayerFeatures(mapLayerId: string, offset: number, limit: number) {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return requestJson(
    `/api/v1/map/layers/${encodeURIComponent(mapLayerId)}/features?${query.toString()}`,
    undefined,
    30_000,
    mapFeaturePageSchema,
  )
}
