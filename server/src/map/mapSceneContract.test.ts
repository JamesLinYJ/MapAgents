// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 地图场景契约测试
//
//   文件:       mapSceneContract.test.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { mapSceneLayerSchema } from '../schemas/types.js'

describe('map scene contract', () => {
  it('validates and defaults persisted label presentation', () => {
    const layer = mapSceneLayerSchema.parse({
      mapLayerId: 'map_layer_1',
      order: 0,
      visible: true,
      opacity: 0.8,
      styleOverride: null,
      label: { field: 'name' },
      currentFrameId: null,
    })

    expect(layer.label).toEqual({
      field: 'name',
      placement: 'auto',
      size: 12,
      color: '#1f2937',
      haloColor: '#ffffff',
      haloWidth: 1.5,
    })
  })
})
