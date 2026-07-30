// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 栅格瓦片数据源渲染器
//
//   文件:       rasterTileSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'
import { desktopMapResourceUrl } from '../desktopMapResourceUrl'

export const rasterTileSourceRenderer = defineSourceRenderer('raster_tiles', (map, id, source) => {
  map.addSource(id, {
    type: 'raster',
    url: desktopMapResourceUrl(source.tileJsonUrl),
    tileSize: source.tileSize,
  })
})
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 栅格瓦片数据源渲染器
//
//   文件:       rasterTileSourceRenderer.ts
// --------------------------------------------------------------------------
