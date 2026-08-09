// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层几何边界测试
//
//   文件:       managedLayerGeometry.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { GeoJsonFeatureCollection } from '../geojson.js'
import { prepareManagedLayerImport } from './managedLayerGeometry.js'

describe('managed layer geometry boundary', () => {
  it('revalidates CRS84 before PostGIS can assign SRID 4326', () => {
    const collection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [13358338.895192828, 3503549.843504374] },
      }],
    } as unknown as GeoJsonFeatureCollection

    expect(() => prepareManagedLayerImport({
      collection,
      name: '非法投影图层',
      sourceType: 'system',
    })).toThrow('投影坐标必须显式声明 CRS')
  })

  it('derives edge-point bounds without clamping both sides to the same longitude', () => {
    const prepared = prepareManagedLayerImport({
      collection: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [180, 90] } }],
      },
      name: '边界点',
      sourceType: 'system',
    })

    expect(prepared.bounds).toEqual([179.9999, 89.9999, 180, 90])
  })
})
