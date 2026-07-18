// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图瓦片网关
//
//   文件:       mapTileGateway.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import path from 'node:path'
import type { Env } from '../framework/env.js'
import type { MapLayerStyle } from '../schemas/types.js'
import type { MapTileExecutionSpec } from '../store/postgres/mapStore.js'

export interface MapTileResponse {
  body: ArrayBuffer
  contentType: string
  cacheControl: string
  etag: string | null
}

export class MapTileGateway {
  constructor(private readonly env: Env) {}

  async fetchTile(spec: MapTileExecutionSpec, z: number, x: number, y: number, signal?: AbortSignal): Promise<MapTileResponse> {
    validateTileCoordinate(z, x, y)
    const source = spec.manifest.source
    if (source.kind === 'vector_tiles') {
      return this.fetchUpstream(this.vectorTileUrl(spec.manifest.mapLayerId, z, x, y), signal)
    }
    if (source.kind === 'raster_tiles' || source.kind === 'raster_dem') {
      if (!spec.artifactRelativePath) throw new Error('栅格瓦片图层缺少已注册 COG Artifact')
      return this.fetchUpstream(this.rasterTileUrl(spec, z, x, y), signal)
    }
    throw new Error(`图层 '${spec.manifest.mapLayerId}' 不是瓦片数据源`)
  }

  private vectorTileUrl(mapLayerId: string, z: number, x: number, y: number): URL {
    const url = new URL(`/geoforge_layer_tiles/${z}/${x}/${y}`, this.env.MARTIN_INTERNAL_URL)
    // Martin 将普通 URL 查询参数组装为 PostgreSQL 函数的 json 参数。
    // 因此这里传字段本身，而不是再包一层名为 query 的 JSON 对象。
    url.searchParams.set('mapLayerId', mapLayerId)
    return url
  }

  private rasterTileUrl(spec: MapTileExecutionSpec, z: number, x: number, y: number): URL {
    const relativePath = normalizeArtifactPath(spec.artifactRelativePath ?? '')
    const url = new URL(`/cog/tiles/WebMercatorQuad/${z}/${x}/${y}.png`, this.env.TITILER_INTERNAL_URL)
    url.searchParams.set('url', `file:///data/${relativePath}`)
    appendRasterStyle(url, spec.manifest.style)
    return url
  }

  private async fetchUpstream(url: URL, signal?: AbortSignal): Promise<MapTileResponse> {
    const timeout = AbortSignal.timeout(this.env.MAP_TILE_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(url, {
      headers: { Accept: 'image/png,application/x-protobuf,application/vnd.mapbox-vector-tile' },
      signal: combinedSignal,
    })
    if (!response.ok) {
      throw new Error(`地图瓦片服务返回 HTTP ${response.status}`)
    }
    return {
      body: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      cacheControl: response.headers.get('cache-control') ?? 'private, max-age=60',
      etag: response.headers.get('etag'),
    }
  }
}

function validateTileCoordinate(z: number, x: number, y: number): void {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 24) throw new Error('地图瓦片坐标无效')
  const upper = 2 ** z
  if (x < 0 || y < 0 || x >= upper || y >= upper) throw new Error('地图瓦片坐标超出当前层级范围')
}

function normalizeArtifactPath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'))
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('COG Artifact 路径无效')
  }
  return normalized.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function appendRasterStyle(url: URL, style: MapLayerStyle): void {
  if (style.kind === 'continuous_raster') {
    url.searchParams.set('rescale', `${style.renderRange[0]},${style.renderRange[1]}`)
    url.searchParams.set('colormap', JSON.stringify(interpolateColormap(style.colorStops)))
    return
  }
  if (style.kind === 'categorical_raster') {
    const colormap = Object.fromEntries(style.categories.flatMap(category => {
      const numeric = typeof category.value === 'number' ? category.value : Number(category.value)
      return Number.isFinite(numeric) ? [[String(numeric), rgba(category.color)]] : []
    }))
    if (!Object.keys(colormap).length) throw new Error('分类栅格图层没有数值型类别')
    url.searchParams.set('colormap', JSON.stringify(colormap))
    return
  }
  if (style.kind !== 'hillshade') throw new Error(`栅格瓦片不支持样式 '${style.kind}'`)
}

function interpolateColormap(stops: Array<{ value: number; color: string }>): Record<string, [number, number, number, number]> {
  const sorted = [...stops].sort((a, b) => a.value - b.value)
  const min = sorted[0]
  const max = sorted.at(-1)
  if (!min || !max || min.value === max.value) throw new Error('连续色带至少需要两个不同数值的色标')
  const result: Record<string, [number, number, number, number]> = {}
  for (let index = 0; index <= 255; index += 1) {
    const value = min.value + (max.value - min.value) * index / 255
    const upperIndex = Math.max(1, sorted.findIndex(stop => stop.value >= value))
    const lower = sorted[upperIndex - 1] ?? min
    const upper = sorted[upperIndex] ?? max
    const ratio = upper.value === lower.value ? 0 : (value - lower.value) / (upper.value - lower.value)
    const lowerColor = rgba(lower.color)
    const upperColor = rgba(upper.color)
    result[String(index)] = [
      Math.round(lowerColor[0] + (upperColor[0] - lowerColor[0]) * ratio),
      Math.round(lowerColor[1] + (upperColor[1] - lowerColor[1]) * ratio),
      Math.round(lowerColor[2] + (upperColor[2] - lowerColor[2]) * ratio),
      Math.round(lowerColor[3] + (upperColor[3] - lowerColor[3]) * ratio),
    ]
  }
  return result
}

function rgba(color: string): [number, number, number, number] {
  const match = /^#([\da-f]{6}|[\da-f]{8})$/iu.exec(color)
  if (!match?.[1]) throw new Error(`不支持的色标颜色 '${color}'`)
  const hex = match[1]
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  ]
}
