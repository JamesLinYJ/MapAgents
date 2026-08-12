// +-------------------------------------------------------------------------
//
//   地理智能平台 - 天地图底图网关
//
//   文件:       tiandituBasemapGateway.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'

export type TiandituTileKind = 'labels' | 'vector'

const TILE_KIND_CODE: Record<TiandituTileKind, 'cva_w' | 'vec_w'> = {
  labels: 'cva_w',
  vector: 'vec_w',
}

const BASEMAP_KEY = 'tianditu-vector'
export class TiandituBasemapGateway {
  private readonly apiKey: string

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey?.trim() ?? ''
  }

  catalog(): BasemapDescriptor[] {
    return [{
      basemapKey: BASEMAP_KEY,
      name: '天地图',
      provider: '国家地理信息公共服务平台',
      kind: 'raster',
      attribution: '© 天地图',
      tileUrls: [`/api/v1/map/basemaps/${BASEMAP_KEY}/tiles/vector/{z}/{x}/{y}`],
      labelTileUrls: [`/api/v1/map/basemaps/${BASEMAP_KEY}/tiles/labels/{z}/{x}/{y}`],
      available: this.apiKey.length > 0,
      isDefault: true,
    }]
  }

  tileRedirectUrl(
    kind: TiandituTileKind,
    z: number,
    x: number,
    y: number,
  ): string {
    validateTileCoordinate(z, x, y)
    if (!this.apiKey) {
      throw new Error('天地图 API KEY 未配置。请先在产品设置中完成底图配置。')
    }

    const shard = (z + x + y) % 8
    const url = new URL(`https://t${shard}.tianditu.gov.cn/DataServer`)
    url.searchParams.set('T', TILE_KIND_CODE[kind])
    url.searchParams.set('x', String(x))
    url.searchParams.set('y', String(y))
    url.searchParams.set('l', String(z))
    url.searchParams.set('tk', this.apiKey)

    return url.toString()
  }
}

function validateTileCoordinate(z: number, x: number, y: number): void {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 18) {
    throw new Error('天地图瓦片坐标无效。')
  }
  const upper = 2 ** z
  if (x < 0 || y < 0 || x >= upper || y >= upper) {
    throw new Error('天地图瓦片坐标超出当前层级范围。')
  }
}
