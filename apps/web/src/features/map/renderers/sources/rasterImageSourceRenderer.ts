// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 栅格图片数据源渲染器
//
//   文件:       rasterImageSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'

export const rasterImageSourceRenderer = defineSourceRenderer('raster_image', (map, id, source) => {
  map.addSource(id, { type: 'image', url: source.url, coordinates: source.coordinates })
})
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 栅格图片数据源渲染器
//
//   文件:       rasterImageSourceRenderer.ts
// --------------------------------------------------------------------------
