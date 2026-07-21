// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 主机指标采集测试
//
//   文件:       hostMetricsService.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { HostMetricsService } from './hostMetricsService.js'

describe('HostMetricsService', () => {
  it('合并并发采集并在有效期内复用完整快照', async () => {
    let releaseLoad!: (value: { currentLoad: number }) => void
    const loadGate = new Promise<{ currentLoad: number }>(resolve => { releaseLoad = resolve })
    const provider = {
      cpu: vi.fn(async () => ({
        manufacturer: 'GeoForge',
        brand: 'Operations CPU',
        physicalCores: 4,
        cores: 8,
      })),
      currentLoad: vi.fn(async () => loadGate),
      mem: vi.fn(async () => ({ total: 1_000, used: 400, available: 600 })),
      fsSize: vi.fn(async () => [{
        fs: 'testfs',
        mount: 'workspace',
        size: 2_000,
        used: 500,
        available: 1_500,
        use: 25,
      }]),
      osInfo: vi.fn(async () => ({
        hostname: 'geoforge-host',
        arch: 'x64',
        distro: 'GeoForge Test OS',
        platform: 'test',
        release: '1.0',
      })),
      time: vi.fn(() => ({ uptime: 120 })),
    }
    const service = new HostMetricsService(
      provider as unknown as ConstructorParameters<typeof HostMetricsService>[0],
      60_000,
    )

    const first = service.snapshot()
    const concurrent = service.snapshot()
    expect(concurrent).toBe(first)

    releaseLoad({ currentLoad: 37.5 })
    const snapshot = await first
    const cached = await service.snapshot()

    expect(cached).toBe(snapshot)
    expect(snapshot).toMatchObject({
      hostname: 'geoforge-host',
      uptimeSeconds: 120,
      cpu: { loadPercent: 37.5 },
      memory: { usedPercent: 40 },
    })
    expect(provider.cpu).toHaveBeenCalledTimes(1)
    expect(provider.osInfo).toHaveBeenCalledTimes(1)
    expect(provider.currentLoad).toHaveBeenCalledTimes(1)
    expect(provider.mem).toHaveBeenCalledTimes(1)
    expect(provider.fsSize).toHaveBeenCalledTimes(1)
    expect(provider.time).toHaveBeenCalledTimes(1)
  })
})
