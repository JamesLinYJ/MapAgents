// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图瓦片网关测试
//
//   文件:       mapTileGateway.test.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../framework/env.js'
import { mapLayerManifestSchema } from '../schemas/types.js'
import { MapTileGateway } from './mapTileGateway.js'

describe('MapTileGateway', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('passes the authorized layer id as a Martin function query field', async () => {
    const fetchMock = vi.fn(async () => tileResponse('application/x-protobuf'))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new MapTileGateway(env())

    await gateway.fetchTile({ manifest: manifest('vector_tiles'), artifactRelativePath: null }, 4, 12, 7)

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/geoforge_layer_tiles/4/12/7')
    expect(url.searchParams.get('mapLayerId')).toBe('map_layer_1')
    expect(url.searchParams.has('query')).toBe(false)
  })

  it('requests a registered COG through TiTiler with the manifest range and colormap', async () => {
    const fetchMock = vi.fn(async () => tileResponse('image/png'))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new MapTileGateway(env())

    await gateway.fetchTile({ manifest: manifest('raster_tiles'), artifactRelativePath: 'artifacts/run_1/rain.tif' }, 5, 25, 13)

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/cog/tiles/WebMercatorQuad/5/25/13.png')
    expect(url.searchParams.get('url')).toBe('file:///data/artifacts/run_1/rain.tif')
    expect(url.searchParams.get('rescale')).toBe('0,50')
    expect(Object.keys(JSON.parse(url.searchParams.get('colormap') ?? '{}'))).toHaveLength(256)
  })
})

function manifest(sourceKind: 'vector_tiles' | 'raster_tiles') {
  return mapLayerManifestSchema.parse({
    mapLayerId: 'map_layer_1',
    ownershipScope: 'thread',
    workspaceId: 'workspace_1',
    threadId: 'thread_1',
    artifactId: sourceKind === 'raster_tiles' ? 'artifact_1' : null,
    managedLayerKey: sourceKind === 'vector_tiles' ? 'managed_1' : null,
    title: '测试图层', status: 'ready', errorMessage: null,
    bounds: [119, 29, 121, 31], crs: 'EPSG:4326', minZoom: 0, maxZoom: 22,
    source: sourceKind === 'vector_tiles'
      ? { kind: 'vector_tiles', tileJsonUrl: '/tiles.json', sourceLayer: 'features' }
      : { kind: 'raster_tiles', tileJsonUrl: '/tiles.json', tileSize: 256 },
    style: sourceKind === 'vector_tiles'
      ? { kind: 'polygon', opacity: 0.7, colorField: null, categories: [], color: '#1976d2', outlineColor: '#0d47a1', outlineWidth: 1 }
      : {
          kind: 'continuous_raster', rangeMode: 'data', dataRange: [0, 50], renderRange: [0, 50], opacity: 0.9,
          colorStops: [{ value: 0, color: '#f7fbff' }, { value: 50, color: '#b71c1c' }],
        },
    legend: null, temporal: null,
    capabilities: { query: true, labels: false, style: true, temporal: false, opacity: true, download: true },
    dataVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
}

function env() {
  return parseEnv({
    API_PORT: '0', API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://user:password@127.0.0.1:5432/geoforge_test',
    RUNTIME_ROOT: 'runtime-test', APP_BASE_URL: 'http://127.0.0.1:8000',
    BETTER_AUTH_URL: 'http://127.0.0.1:8000', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-spatial',
    MARTIN_INTERNAL_URL: 'http://martin.internal:3000', TITILER_INTERNAL_URL: 'http://titiler.internal:8000',
  })
}

function tileResponse(contentType: string): Response {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': contentType } })
}
