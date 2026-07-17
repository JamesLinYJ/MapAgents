// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 默认地图渲染器装配
//
//   文件:       defaultRendererRegistry.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { MapLayerRendererRegistry } from './MapLayerRendererRegistry'
import { defaultSourceRenderers } from './sources'
import { defaultStyleRenderers } from './styles'

export const defaultRendererRegistry = new MapLayerRendererRegistry(
  defaultSourceRenderers,
  defaultStyleRenderers,
)
// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 默认地图渲染器装配
//
//   文件:       defaultRendererRegistry.ts
// --------------------------------------------------------------------------
