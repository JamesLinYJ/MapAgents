// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - GeoJSON 数据源渲染器
//
//   文件:       geoJsonSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'

export const geoJsonSourceRenderer = defineSourceRenderer('geojson', (map, id, source, style) => {
  map.addSource(id, {
    type: 'geojson',
    data: source.url,
    ...(style.kind === 'point' && style.cluster
      ? { cluster: true, clusterRadius: 52, clusterMaxZoom: 13 }
      : {}),
  })
})
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - GeoJSON 数据源渲染器
//
//   文件:       geoJsonSourceRenderer.ts
// --------------------------------------------------------------------------
