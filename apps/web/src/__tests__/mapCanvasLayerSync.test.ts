// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图图层同步测试
//
//   文件:       mapCanvasLayerSync.test.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { buildLabelLayerDefinition } from '../features/map/MapCanvasLayerSync'

describe('map label renderer', () => {
  it('builds a persisted vector label as a MapLibre symbol layer', () => {
    const layer = buildLabelLayerDefinition(
      'map-layer-districts',
      { kind: 'vector_tiles', tileJsonUrl: '/tilejson', sourceLayer: 'features' },
      {
        kind: 'polygon', opacity: 0.7, colorField: null, categories: [], color: '#2e9f7d',
        outlineColor: '#176c55', outlineWidth: 1,
      },
      {
        field: 'name', placement: 'auto', size: 13, color: '#17202a',
        haloColor: '#ffffff', haloWidth: 2,
      },
      true,
      0.8,
    )

    expect(layer.type).toBe('symbol')
    expect(layer).toMatchObject({
      source: 'map-layer-districts',
      'source-layer': 'features',
      layout: {
        visibility: 'visible',
        'symbol-placement': 'point',
        'text-field': ['to-string', ['get', 'name']],
        'text-size': 13,
      },
      paint: {
        'text-color': '#17202a',
        'text-opacity': 0.8,
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
      },
    })
  })
})
