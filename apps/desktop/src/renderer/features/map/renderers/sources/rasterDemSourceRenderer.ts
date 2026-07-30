// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - DEM 数据源渲染器
//
//   文件:       rasterDemSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'
import { desktopMapResourceUrl } from '../desktopMapResourceUrl'

export const rasterDemSourceRenderer = defineSourceRenderer('raster_dem', (map, id, source) => {
  map.addSource(id, {
    type: 'raster-dem',
    url: desktopMapResourceUrl(source.tileJsonUrl),
    tileSize: source.tileSize,
    encoding: source.encoding,
  })
})
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - DEM 数据源渲染器
//
//   文件:       rasterDemSourceRenderer.ts
// --------------------------------------------------------------------------
