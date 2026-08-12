// +-------------------------------------------------------------------------
//
//   地理智能平台 - 天地图底图网关测试
//
//   文件:       tiandituBasemapGateway.test.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { TiandituBasemapGateway } from './tiandituBasemapGateway.js'

describe('TiandituBasemapGateway', () => {
  it('publishes only the proxied Tianditu vector basemap without exposing the API key', () => {
    const gateway = new TiandituBasemapGateway('local-secret-fixture')

    const catalog = gateway.catalog()

    expect(catalog).toEqual([expect.objectContaining({
      basemapKey: 'tianditu-vector',
      name: '天地图',
      available: true,
      isDefault: true,
      tileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}'],
      labelTileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}'],
    })])
    expect(JSON.stringify(catalog)).not.toContain('local-secret-fixture')
  })

  it('marks the sole basemap unavailable when the local key has not been configured', () => {
    expect(new TiandituBasemapGateway(undefined).catalog()[0]?.available).toBe(false)
  })

  it('injects the browser-scoped key only into a validated Tianditu redirect', () => {
    const gateway = new TiandituBasemapGateway('local-secret-fixture')

    const requestedUrl = new URL(gateway.tileRedirectUrl('labels', 4, 13, 6))

    expect(requestedUrl.origin).toMatch(/^https:\/\/t[0-7]\.tianditu\.gov\.cn$/u)
    expect(requestedUrl.searchParams.get('T')).toBe('cva_w')
    expect(requestedUrl.searchParams.get('tk')).toBe('local-secret-fixture')
  })

  it('rejects invalid coordinates before contacting Tianditu', () => {
    const gateway = new TiandituBasemapGateway('local-secret-fixture')

    expect(() => gateway.tileRedirectUrl('vector', 2, 4, 0)).toThrow('超出当前层级范围')
  })
})
