// +-------------------------------------------------------------------------
//
//   地理智能平台 - 底图 HTTP 路由测试
//
//   文件:       mapBasemap.test.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { MapTileGateway } from '../map/mapTileGateway.js'
import { TiandituBasemapGateway } from '../map/tiandituBasemapGateway.js'
import type { SecurityServices } from '../security/routes.js'
import type { MapStore } from '../store/postgres/mapStore.js'
import { mapRoutes } from './map.js'

describe('map basemap routes', () => {
  it('parses the complete y coordinate and redirects an authenticated tile route to Tianditu', async () => {
    const app = mapRoutes({
      mapStore: {} as MapStore,
      tileGateway: {} as MapTileGateway,
      tiandituBasemapGateway: new TiandituBasemapGateway('browser-key-fixture'),
      security: {} as SecurityServices,
    })

    const response = await app.request(
      '/api/v1/map/basemaps/tianditu-vector/tiles/vector/4/13/6',
    )

    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.hostname).toMatch(/^t[0-7]\.tianditu\.gov\.cn$/u)
    expect(location.searchParams.get('T')).toBe('vec_w')
    expect(location.searchParams.get('x')).toBe('13')
    expect(location.searchParams.get('y')).toBe('6')
    expect(location.searchParams.get('l')).toBe('4')
    expect(location.searchParams.get('tk')).toBe('browser-key-fixture')
  })
})
