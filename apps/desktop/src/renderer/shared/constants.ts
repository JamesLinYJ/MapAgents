// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端默认常量
//
//   文件:       constants.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import {
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

export interface DataReferenceSummary {
  id: string
  kind: 'layer' | 'file' | 'artifact' | 'meteorology'
  name: string
  status: string
  detail: string
  relativePath?: string
}

export const SAMPLES = [
  '帮我看看杭州今天短时强降水风险主要集中在哪些区',
  '把我上传的定量降水预报数据做成一张风险区划图',
  '基于现有雷达资料生成天气雷达组网拼图，并给我一个简短说明',
] as const

// 默认底图只在服务端底图列表尚未返回时兜底显示。桌面 Renderer 不直接访问公网；
// Main 进程通过受控协议校验瓦片坐标并代理 OSM，请求边界与正式底图列表保持一致。
export const DEFAULT_BASEMAP: BasemapDescriptor = {
  basemapKey: 'osm',
  name: 'OpenStreetMap',
  provider: 'osm',
  kind: 'raster',
  attribution: '© OpenStreetMap contributors',
  tileUrls: [`${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://basemap/osm/{z}/{x}/{y}.png`],
  labelTileUrls: [],
  available: true,
  isDefault: true,
}
