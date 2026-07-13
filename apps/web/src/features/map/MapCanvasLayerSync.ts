// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图结果图层同步
//
//   文件:       MapCanvasLayerSync.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 把 GeoForge artifact 图层同步到 MapLibre style source/layer。这里是地图图层写入
// 的唯一规则边界，组件层只负责调用，几何工具只负责计算。

import maplibregl, { LngLatBounds, Map } from 'maplibre-gl/dist/maplibre-gl-csp'

import type { MapCanvasLayer } from './MapCanvasEngine'
import {
  boundsFromLayer,
  collectGeometryTypes,
  extendBounds,
  hasRouteProperties,
  readLabelField,
} from './MapCanvasEngine'

const LAYER_PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
]

export function pickLayerColor(metadata: Record<string, unknown> | undefined, index: number): string {
  const color = metadata?.color
  if (typeof color === 'string') {
    return color
  }
  const paletteColor = LAYER_PALETTE[index % LAYER_PALETTE.length]
  if (!paletteColor) throw new Error('图层调色板不能为空。')
  return paletteColor
}

export function rasterPaintFromMetadata(metadata: Record<string, unknown> | undefined, opacity: number): Record<string, number> {
  const color = metadata?.layerColorOverride === true && typeof metadata.color === 'string'
    ? metadata.color
    : null
  const hue = color ? colorToHueDegrees(color) : 0
  return {
    'raster-opacity': opacity,
    'raster-fade-duration': 120,
    'raster-hue-rotate': hue,
    'raster-saturation': color ? 0.32 : 0,
    'raster-contrast': color ? 0.08 : 0,
  }
}

export function colorToHueDegrees(color: string) {
  const hex = color.replace('#', '').trim()
  const normalized = hex.length === 3
    ? hex.split('').map(char => char + char).join('')
    : hex
  if (!/^[0-9a-f]{6}$/iu.test(normalized)) return 0
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  let hue = 0
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return Math.round((hue * 60 + 360) % 360)
}

export function syncArtifactLayers(
  map: Map,
  layers: MapCanvasLayer[],
  selectedArtifactId?: string,
) {
  const activeSourceIds = new Set(layers.map(({ artifact }) => `artifact-${artifact.artifactId}`))
  removeStaleArtifactLayers(map, activeSourceIds)

  const bounds = new LngLatBounds()
  let hasBounds = false

  layers.forEach((layer, index) => {
    const { artifact, data, visible, opacity } = layer
    const sourceId = `artifact-${artifact.artifactId}`
    if (layer.kind === 'raster') {
      syncRasterLayerSet(map, layer, sourceId, visible ? 'visible' : 'none', opacity)
      const rasterBounds = boundsFromLayer(layer)
      if (rasterBounds && !rasterBounds.isEmpty()) {
        bounds.extend(rasterBounds.getSouthWest())
        bounds.extend(rasterBounds.getNorthEast())
        hasBounds = true
      }
      return
    }

    if (!data) {
      return
    }
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined
    if (source && typeof source.setData === 'function') {
      source.setData(data)
    } else {
      if (source) {
        removeArtifactSource(map, sourceId)
      }
      map.addSource(sourceId, {
        type: 'geojson',
        data,
      })
    }

    if (data.features.length) {
      extendBounds(bounds, data)
      hasBounds = true
    }

    syncArtifactLayerSet({
      map,
      layer,
      sourceId,
      color: pickLayerColor(artifact.metadata as Record<string, unknown> | undefined, index),
      selected: artifact.artifactId === selectedArtifactId,
      visible,
      opacity,
    })
  })

  applyArtifactLayerOrder(map, layers)

  return hasBounds ? bounds : null
}

export function removeStaleArtifactLayers(map: Map, activeSourceIds: Set<string>) {
  const style = map.getStyle()
  style.layers
    ?.filter((layer) => {
      const sourceId = 'source' in layer ? String(layer.source) : ''
      return layer.id.startsWith('artifact-') && !activeSourceIds.has(sourceId)
    })
    .forEach((layer) => {
      if (map.getLayer(layer.id)) {
        map.removeLayer(layer.id)
      }
    })

  Object.keys(style.sources)
    .filter((sourceId) => sourceId.startsWith('artifact-') && !activeSourceIds.has(sourceId))
    .forEach((sourceId) => {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId)
      }
    })
}

export function removeArtifactSource(map: Map, sourceId: string) {
  map.getStyle().layers
    ?.filter((layer) => 'source' in layer && String(layer.source) === sourceId)
    .forEach((layer) => {
      if (map.getLayer(layer.id)) {
        map.removeLayer(layer.id)
      }
    })
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId)
  }
}

export function applyArtifactLayerOrder(map: Map, layers: MapCanvasLayer[]) {
  // MapLibre 的真实绘制顺序来自 style layer 顺序；仅改变 React 数组不会移动已存在图层。
  //
  // 这里按面板输出的图层顺序把每个 artifact 子图层依次移到顶层，使“上移/下移”和地图叠放一致。
  for (const layer of layers) {
    for (const layerId of artifactRenderedLayerIds(layer.artifact.artifactId)) {
      if (map.getLayer(layerId)) {
        map.moveLayer(layerId)
      }
    }
  }
}

export function artifactRenderedLayerIds(artifactId: string) {
  const sourceId = `artifact-${artifactId}`
  return [
    `${sourceId}-raster`,
    `${sourceId}-fill`,
    `${sourceId}-outline`,
    `${sourceId}-path`,
    `${sourceId}-point`,
    `${sourceId}-label`,
  ]
}

export function syncRasterLayerSet(
  map: Map,
  layer: MapCanvasLayer,
  sourceId: string,
  visibility: 'visible' | 'none',
  opacity: number,
) {
  if (!layer.imageUrl || !layer.coordinates) {
    removeArtifactSource(map, sourceId)
    return
  }
  const source = map.getSource(sourceId) as (maplibregl.ImageSource & { updateImage?: (options: { url: string; coordinates: [[number, number], [number, number], [number, number], [number, number]] }) => void }) | undefined
  if (source && typeof source.updateImage === 'function') {
    source.updateImage({ url: layer.imageUrl, coordinates: layer.coordinates })
  } else {
    if (source) {
      removeArtifactSource(map, sourceId)
    }
    map.addSource(sourceId, {
      type: 'image',
      url: layer.imageUrl,
      coordinates: layer.coordinates,
    })
  }
  const layerId = `${sourceId}-raster`
  const rasterPaint = rasterPaintFromMetadata(layer.artifact.metadata as Record<string, unknown> | undefined, opacity)
  if (!map.getLayer(layerId)) {
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: rasterPaint,
      layout: { visibility },
    })
    return
  }
  map.setLayoutProperty(layerId, 'visibility', visibility)
  Object.entries(rasterPaint).forEach(([property, value]) => {
    map.setPaintProperty(layerId, property, value)
  })
}

export function syncArtifactLayerSet({
  map,
  layer,
  sourceId,
  color,
  selected,
  visible,
  opacity,
}: {
  map: Map
  layer: MapCanvasLayer
  sourceId: string
  color: string
  selected: boolean
  visible: boolean
  opacity: number
}) {
  if (!layer.data) {
    return
  }
  const geometryTypes = collectGeometryTypes(layer.data)
  const visibility = visible ? 'visible' : 'none'
  const isRoute = hasRouteProperties(layer.data)
  const featureColor = featureColorExpression(layer.data, color)
  const metadata = layer.artifact.metadata as Record<string, unknown> | undefined
  const labelField = readLabelField(layer.data, metadata)

  syncMapLayer(map, {
    id: `${sourceId}-fill`,
    type: 'fill',
    sourceId,
    enabled: geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon'),
    visibility,
    paint: {
      'fill-color': featureColor,
      'fill-opacity': (selected ? 0.24 : 0.16) * opacity,
    },
  })
  syncMapLayer(map, {
    id: `${sourceId}-outline`,
    type: 'line',
    sourceId,
    enabled: geometryTypes.has('Polygon') || geometryTypes.has('MultiPolygon'),
    visibility,
    paint: {
      'line-color': featureColor,
      'line-width': selected ? 3 : 2,
      'line-opacity': 0.85 * opacity,
    },
  })
  const routeDashSequence = isRoute
    ? ['match', ['get', 'route_index'],
        0, ['literal', [1]],
        1, ['literal', [6, 3]],
        2, ['literal', [3, 2, 1, 2]],
        ['literal', [1]],
      ] as unknown as maplibregl.Expression
    : undefined
  syncMapLayer(map, {
    id: `${sourceId}-path`,
    type: 'line',
    sourceId,
    enabled: geometryTypes.has('LineString') || geometryTypes.has('MultiLineString'),
    visibility,
    paint: {
      'line-color': featureColor,
      'line-width': isRoute ? (selected ? 5 : 3.2) : (selected ? 4 : 2.4),
      'line-opacity': 0.92 * opacity,
      ...(routeDashSequence ? { 'line-dasharray': routeDashSequence } : {}),
    },
  })
  const pointColorExpr = isRoute
    ? ['match', ['get', 'kind'],
        'route_start', '#34c759',
        'route_end', '#ff3b30',
        color,
      ] as unknown as maplibregl.Expression
    : featureColor
  syncMapLayer(map, {
    id: `${sourceId}-point`,
    type: 'circle',
    sourceId,
    enabled: geometryTypes.has('Point') || geometryTypes.has('MultiPoint'),
    visibility,
    paint: {
      'circle-radius': isRoute ? 7 : (selected ? 8 : 6),
      'circle-color': pointColorExpr,
      'circle-stroke-width': isRoute ? 2.5 : 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': opacity,
    },
  })
  syncSymbolLayer(map, {
    id: `${sourceId}-label`,
    sourceId,
    enabled: Boolean(metadata?.labelEnabled === true && labelField),
    visibility,
    fieldName: labelField,
  })
}

export function featureColorExpression(collection: GeoJSON.FeatureCollection, fallback: string) {
  const hasFeatureColor = collection.features.some((feature) => {
    const props = feature.properties as Record<string, unknown> | null | undefined
    return typeof props?.risk_color === 'string' || typeof props?.color === 'string'
  })
  if (!hasFeatureColor) {
    return fallback
  }
  return ['coalesce', ['get', 'risk_color'], ['get', 'color'], fallback] as unknown as maplibregl.Expression
}

export function syncMapLayer(
  map: Map,
  {
    id,
    type,
    sourceId,
    enabled,
    visibility,
    paint,
  }: {
    id: string
    type: 'fill' | 'line' | 'circle'
    sourceId: string
    enabled: boolean
    visibility: 'visible' | 'none'
    paint: Record<string, unknown>
  },
) {
  if (!enabled) {
    if (map.getLayer(id)) {
      map.removeLayer(id)
    }
    return
  }

  if (!map.getLayer(id)) {
    map.addLayer({
      id,
      type,
      source: sourceId,
      paint,
      layout: { visibility },
    } as Parameters<Map['addLayer']>[0])
    return
  }

  map.setLayoutProperty(id, 'visibility', visibility)
  Object.entries(paint).forEach(([property, value]) => {
    map.setPaintProperty(id, property, value)
  })
}

export function syncSymbolLayer(
  map: Map,
  {
    id,
    sourceId,
    enabled,
    visibility,
    fieldName,
  }: {
    id: string
    sourceId: string
    enabled: boolean
    visibility: 'visible' | 'none'
    fieldName?: string
  },
) {
  if (!enabled || !fieldName) {
    if (map.getLayer(id)) {
      map.removeLayer(id)
    }
    return
  }

  const layout = {
    visibility,
    'text-field': ['to-string', ['get', fieldName]],
    'text-size': 12,
    'text-offset': [0, 1.1],
    'text-anchor': 'top',
    'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
  }
  const paint = {
    'text-color': '#111827',
    'text-halo-color': '#ffffff',
    'text-halo-width': 1.4,
    'text-halo-blur': 0.2,
  }

  if (!map.getLayer(id)) {
    map.addLayer({
      id,
      type: 'symbol',
      source: sourceId,
      layout,
      paint,
    } as Parameters<Map['addLayer']>[0])
    return
  }

  map.setLayoutProperty(id, 'visibility', visibility)
  map.setLayoutProperty(id, 'text-field', layout['text-field'])
}
