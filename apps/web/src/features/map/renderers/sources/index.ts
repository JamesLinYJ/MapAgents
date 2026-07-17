// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 默认数据源渲染器目录
//
//   文件:       index.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { MapSourceRenderer } from '../rendererTypes'
import { geoJsonSourceRenderer } from './geoJsonSourceRenderer'
import { rasterDemSourceRenderer } from './rasterDemSourceRenderer'
import { rasterImageSourceRenderer } from './rasterImageSourceRenderer'
import { rasterTileSourceRenderer } from './rasterTileSourceRenderer'
import { vectorTileSourceRenderer } from './vectorTileSourceRenderer'

export const defaultSourceRenderers: MapSourceRenderer[] = [
  geoJsonSourceRenderer,
  vectorTileSourceRenderer,
  rasterImageSourceRenderer,
  rasterTileSourceRenderer,
  rasterDemSourceRenderer,
]
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 默认数据源渲染器目录
//
//   文件:       index.ts
// --------------------------------------------------------------------------
