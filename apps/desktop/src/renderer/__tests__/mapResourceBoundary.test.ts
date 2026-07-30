// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面地图资源边界测试
//
//   文件:       mapResourceBoundary.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { buildBasemapStyle } from '../features/map/MapCanvasEngine'
import { desktopMapResourceUrl } from '../features/map/renderers/desktopMapResourceUrl'
import { DEFAULT_BASEMAP } from '../shared/constants'

describe('desktop map resource boundary', () => {
  it('routes the bootstrap basemap through the controlled Main-process protocol', () => {
    expect(DEFAULT_BASEMAP.tileUrls).toEqual([
      'geoforge-resource://basemap/osm/{z}/{x}/{y}.png',
    ])

    const style = buildBasemapStyle(DEFAULT_BASEMAP)
    expect(style.sources.basemap).toMatchObject({
      type: 'raster',
      tiles: DEFAULT_BASEMAP.tileUrls,
    })
  })

  it('projects only validated relative API resources at the MapLibre boundary', () => {
    expect(desktopMapResourceUrl('/api/v1/map/layers/layer_1/tilejson')).toBe(
      'geoforge-resource://api/api/v1/map/layers/layer_1/tilejson',
    )
    expect(() => desktopMapResourceUrl('https://example.com/tilejson')).toThrow(
      '地图资源地址不在桌面受控范围内',
    )
  })
})
