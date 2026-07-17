// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 矢量瓦片数据源渲染器
//
//   文件:       vectorTileSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'

export const vectorTileSourceRenderer = defineSourceRenderer('vector_tiles', (map, id, source) => {
  map.addSource(id, { type: 'vector', url: source.tileJsonUrl })
})
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 矢量瓦片数据源渲染器
//
//   文件:       vectorTileSourceRenderer.ts
// --------------------------------------------------------------------------
