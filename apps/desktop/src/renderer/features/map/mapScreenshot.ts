import {
  mapScreenshotContextSchema,
  type MapScreenshotContext,
} from '@geo-agent-platform/shared-types'

import type { SceneRenderLayer } from './useMapScene'
import { sceneSourceId } from './MapCanvasLayerSync'

export interface MapScreenshotViewport {
  bounds: [number, number, number, number]
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
}

export interface MapScreenshotRenderEvidence {
  status: 'idle'
  tilesLoaded: true
  renderedLayerIds: readonly string[]
}

interface MapRenderEvidenceReader {
  getStyle(): { layers?: Array<{ layout?: { visibility?: unknown }; source?: unknown }> } | undefined
  getSource(sourceId: string): unknown
  isSourceLoaded(sourceId: string): boolean
}

/** 从实际 MapLibre style/source 状态生成截图图层证据。 */
export function collectRenderedSceneLayerIds(
  map: MapRenderEvidenceReader,
  layers: readonly SceneRenderLayer[],
  layerErrors: Readonly<Record<string, string>>,
): string[] {
  const renderedSourceIds = new Set<string>()
  for (const styleLayer of map.getStyle()?.layers ?? []) {
    if (styleLayer.layout?.visibility === 'none') continue
    if (typeof styleLayer.source === 'string') renderedSourceIds.add(styleLayer.source)
  }
  return layers.flatMap(layer => {
    if (!layer.scene.visible || layerErrors[layer.manifest.mapLayerId]) return []
    const sourceId = sceneSourceId(layer.manifest.mapLayerId)
    if (!renderedSourceIds.has(sourceId) || !map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) return []
    return [layer.manifest.mapLayerId]
  })
}

/** Build the exact structured context that accompanies a rendered map image. */
export function buildMapScreenshotContext(
  viewport: MapScreenshotViewport,
  layers: readonly SceneRenderLayer[],
  evidence: MapScreenshotRenderEvidence,
  capturedAt = new Date().toISOString(),
): MapScreenshotContext {
  const renderedLayerIds = new Set(evidence.renderedLayerIds)
  const renderedLayers = layers
    .filter(layer => layer.scene.visible && renderedLayerIds.has(layer.manifest.mapLayerId))
    .map(layer => {
      const temporal = layer.manifest.temporal
      const currentFrameId = temporal
        ? (layer.scene.currentFrameId ?? temporal.defaultFrameId)
        : null
      const currentFrame = temporal?.frames.find(frame => frame.frameId === currentFrameId)
      return {
        mapLayerId: layer.manifest.mapLayerId,
        title: layer.manifest.title,
        currentFrameId,
        validTime: currentFrame?.validTime ?? null,
      }
    })
  const validTimes = renderedLayers
    .flatMap(layer => layer.validTime ? [layer.validTime] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))

  return mapScreenshotContextSchema.parse({
    capturedAt,
    viewport: {
      bounds: normalizeBounds(viewport.bounds),
      center: [normalizeLongitude(viewport.center[0]), viewport.center[1]],
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
    },
    crs: 'OGC:CRS84',
    renderProjection: 'EPSG:3857',
    renderState: {
      status: evidence.status,
      tilesLoaded: evidence.tilesLoaded,
    },
    renderedLayers,
    timeRange: validTimes.length
      ? { start: validTimes[0], end: validTimes[validTimes.length - 1] }
      : null,
  })
}

function normalizeBounds(
  [west, south, east, north]: [number, number, number, number],
): [number, number, number, number] {
  const longitudeSpan = east - west
  if (Number.isFinite(longitudeSpan) && longitudeSpan >= 360) {
    return [-180, south, 180, north]
  }
  return [normalizeLongitude(west), south, normalizeLongitude(east), north]
}

function normalizeLongitude(value: number): number {
  if (!Number.isFinite(value)) return value
  const normalized = ((value + 180) % 360 + 360) % 360 - 180
  return Object.is(normalized, -0) ? 0 : normalized
}
