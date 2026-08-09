import { describe, expect, it } from 'vitest'

import type { SceneRenderLayer } from './useMapScene'
import { buildMapScreenshotContext, collectRenderedSceneLayerIds } from './mapScreenshot'

describe('map screenshot context', () => {
  it('records viewport, CRS, visible layers and temporal range without image-derived text', () => {
    const layers = [{
      manifest: {
        mapLayerId: 'radar_1',
        title: '雷达回波',
        temporal: {
          defaultFrameId: 'frame_1',
          frames: [
            { frameId: 'frame_1', validTime: '2026-08-08T03:00:00.000Z', label: '03:00' },
            { frameId: 'frame_2', validTime: '2026-08-08T04:00:00.000Z', label: '04:00' },
          ],
        },
      },
      scene: { visible: true, currentFrameId: 'frame_2' },
    }, {
      manifest: { mapLayerId: 'hidden_1', title: '隐藏图层', temporal: null },
      scene: { visible: false, currentFrameId: null },
    }] as unknown as SceneRenderLayer[]

    const result = buildMapScreenshotContext({
      bounds: [119, 29, 121, 31],
      center: [120, 30],
      zoom: 8,
      bearing: 12,
      pitch: 30,
    }, layers, {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: ['radar_1'],
    }, '2026-08-08T04:10:00.000Z')

    expect(result).toMatchObject({
      capturedAt: '2026-08-08T04:10:00.000Z',
      crs: 'OGC:CRS84',
      renderProjection: 'EPSG:3857',
      renderState: { status: 'idle', tilesLoaded: true },
      viewport: { bounds: [119, 29, 121, 31], center: [120, 30], zoom: 8 },
      renderedLayers: [{
        mapLayerId: 'radar_1',
        currentFrameId: 'frame_2',
        validTime: '2026-08-08T04:00:00.000Z',
      }],
      timeRange: {
        start: '2026-08-08T04:00:00.000Z',
        end: '2026-08-08T04:00:00.000Z',
      },
    })
    expect(JSON.stringify(result)).not.toContain('data:image')
  })

  it('keeps an antimeridian viewport wrapped instead of expanding it to the whole world', () => {
    const result = buildMapScreenshotContext({
      bounds: [170, -10, 190, 10],
      center: [180, 0],
      zoom: 4,
      bearing: 0,
      pitch: 0,
    }, [], {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: [],
    }, '2026-08-08T04:10:00.000Z')

    expect(result.viewport.bounds).toEqual([170, -10, -170, 10])
    expect(result.viewport.center).toEqual([-180, 0])
  })

  it('only records layers proven to be rendered', () => {
    const layers = [{
      manifest: { mapLayerId: 'ready_1', title: '已渲染', temporal: null },
      scene: { visible: true, currentFrameId: null },
    }, {
      manifest: { mapLayerId: 'loading_1', title: '尚未渲染', temporal: null },
      scene: { visible: true, currentFrameId: null },
    }] as unknown as SceneRenderLayer[]

    const result = buildMapScreenshotContext({
      bounds: [119, 29, 121, 31],
      center: [120, 30],
      zoom: 8,
      bearing: 0,
      pitch: 0,
    }, layers, {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: ['ready_1'],
    }, '2026-08-08T04:10:00.000Z')

    expect(result.renderedLayers.map(layer => layer.mapLayerId)).toEqual(['ready_1'])
  })

  it('derives rendered layer ids from visible, loaded MapLibre sources without layer errors', () => {
    const layers = ['ready_1', 'loading_1', 'hidden_1', 'error_1'].map(mapLayerId => ({
      manifest: { mapLayerId },
      scene: { visible: mapLayerId !== 'hidden_1' },
    })) as unknown as SceneRenderLayer[]
    const map = {
      getStyle: () => ({
        layers: [
          { source: 'map-layer-ready_1' },
          { source: 'map-layer-loading_1' },
          { source: 'map-layer-error_1' },
          { source: 'map-layer-hidden_1', layout: { visibility: 'none' } },
        ],
      }),
      getSource: () => ({}),
      isSourceLoaded: (sourceId: string) => sourceId !== 'map-layer-loading_1',
    }

    expect(collectRenderedSceneLayerIds(map, layers, { error_1: '图层失败' }))
      .toEqual(['ready_1'])
  })
})
