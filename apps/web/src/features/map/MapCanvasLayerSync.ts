// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图场景图层同步器
//
//   文件:       MapCanvasLayerSync.ts
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl/dist/maplibre-gl-csp'
import type { MapLayerSource } from '@geo-agent-platform/shared-types'
import type { SceneRenderLayer } from './useMapScene'
import { defaultRendererRegistry } from './renderers/defaultRendererRegistry'
import type { MapLayerRendererRegistry } from './renderers/MapLayerRendererRegistry'

export { buildLabelLayerDefinition } from './renderers/styles'

const sourceSignatures = new WeakMap<MapLibreMap, Map<string, string>>()

export interface MapLayerSyncResult {
  bounds: LngLatBounds | null
  errors: Record<string, string>
}

/** 同步 MapScene 投影。每个图层独立失败，单层错误不会清空其他图层。 */
export function syncSceneLayers(
  map: MapLibreMap,
  layers: SceneRenderLayer[],
  selectedMapLayerId?: string,
  registry: MapLayerRendererRegistry = defaultRendererRegistry,
): MapLayerSyncResult {
  const signatures = sourceSignatures.get(map) ?? new Map<string, string>()
  sourceSignatures.set(map, signatures)
  const activeSourceIds = new Set(layers.map(layer => sceneSourceId(layer.manifest.mapLayerId)))
  removeStaleSceneLayers(map, activeSourceIds, signatures)

  const totalBounds = new LngLatBounds()
  const errors: Record<string, string> = {}
  let hasBounds = false
  for (const layer of layers) {
    try {
      syncSceneLayer(
        map,
        layer,
        layer.manifest.mapLayerId === selectedMapLayerId,
        signatures,
        registry,
      )
      const [west, south, east, north] = layer.manifest.bounds
      totalBounds.extend([west, south])
      totalBounds.extend([east, north])
      hasBounds = true
    } catch (error) {
      errors[layer.manifest.mapLayerId] = error instanceof Error ? error.message : String(error)
    }
  }
  return { bounds: hasBounds ? totalBounds : null, errors }
}

function syncSceneLayer(
  map: MapLibreMap,
  layer: SceneRenderLayer,
  selected: boolean,
  signatures: Map<string, string>,
  registry: MapLayerRendererRegistry,
): void {
  const manifest = layer.manifest
  if (manifest.status !== 'ready') {
    throw new Error(manifest.errorMessage ?? `图层状态为 ${manifest.status}`)
  }
  const source = sourceForCurrentFrame(layer)
  const style = layer.scene.styleOverride ?? manifest.style
  const id = sceneSourceId(manifest.mapLayerId)
  const signature = JSON.stringify(source)
  if (signatures.get(id) !== signature || !map.getSource(id)) {
    removeSceneSource(map, id)
    registry.addSource(map, id, source, style)
    signatures.set(id, signature)
  }
  removeSceneLayers(map, id)
  registry.addStyle({
    map,
    id,
    source,
    style,
    label: layer.scene.label,
    visible: layer.scene.visible,
    sceneOpacity: layer.scene.opacity,
    selected,
  })
}

function sourceForCurrentFrame(layer: SceneRenderLayer): MapLayerSource {
  const temporal = layer.manifest.temporal
  if (!temporal) return layer.manifest.source
  const frameId = layer.scene.currentFrameId ?? temporal.defaultFrameId
  const frame = temporal.frames.find(candidate => candidate.frameId === frameId)
  if (!frame) throw new Error(`时间帧 '${frameId}' 不存在`)
  return frame.source ?? layer.manifest.source
}

function removeStaleSceneLayers(
  map: MapLibreMap,
  activeSourceIds: Set<string>,
  signatures: Map<string, string>,
): void {
  for (const id of [...signatures.keys()]) {
    if (activeSourceIds.has(id)) continue
    removeSceneSource(map, id)
    signatures.delete(id)
  }
}

function removeSceneLayers(map: MapLibreMap, id: string): void {
  for (const layer of [...(map.getStyle()?.layers ?? [])].reverse()) {
    if (layer.id.startsWith(`${id}-`) && map.getLayer(layer.id)) map.removeLayer(layer.id)
  }
}

function removeSceneSource(map: MapLibreMap, id: string): void {
  removeSceneLayers(map, id)
  if (map.getSource(id)) map.removeSource(id)
}

export function sceneSourceId(mapLayerId: string): string {
  return `map-layer-${mapLayerId}`
}
