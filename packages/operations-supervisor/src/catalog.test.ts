// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 固定服务拓扑测试
//
//   文件:       catalog.test.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SERVICE_CATALOG, SERVICE_ORDER, transitiveDependencies, transitiveDependents } from './catalog.js'

describe('fixed service catalog', () => {
  it('exposes only the four audited service identifiers', () => {
    expect(SERVICE_ORDER).toEqual(['infra', 'worker', 'api', 'web'])
    expect(Object.keys(SERVICE_CATALOG).sort()).toEqual([...SERVICE_ORDER].sort())
  })

  it('starts dependencies forward and resolves dependents for reverse shutdown', () => {
    expect(transitiveDependencies('web')).toEqual(['infra', 'worker', 'api'])
    expect(transitiveDependents('infra')).toEqual(['worker', 'api', 'web'])
    expect(transitiveDependents('worker')).toEqual(['api', 'web'])
  })

  it('allows the serialized Docker Desktop probe to finish without false timeout failures', () => {
    expect(SERVICE_CATALOG.infra.health).toMatchObject({
      kind: 'exec',
      timeoutMs: 30_000,
      periodMs: 10_000,
    })
  })

  it('does not admit commands, paths or environment values through the public catalog key', () => {
    for (const serviceId of SERVICE_ORDER) {
      expect(SERVICE_CATALOG[serviceId].serviceId).toBe(serviceId)
      expect(SERVICE_CATALOG[serviceId].dependencies.every(value => SERVICE_ORDER.includes(value))).toBe(true)
    }
  })
})
