// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 主机指标采集
//
//   文件:       hostMetricsService.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { opsHostSnapshotSchema, type OpsHostSnapshot } from '@geo-agent-platform/shared-types/operations'
import si from 'systeminformation'

interface HostInformationProvider {
  cpu: typeof si.cpu
  currentLoad: typeof si.currentLoad
  mem: typeof si.mem
  fsSize: typeof si.fsSize
  osInfo: typeof si.osInfo
  time: typeof si.time
}

export class HostMetricsService {
  private inFlight: Promise<OpsHostSnapshot> | null = null
  private cached: { value: OpsHostSnapshot; sampledAt: number } | null = null
  private staticInformation: Promise<{
    cpu: Awaited<ReturnType<typeof si.cpu>>
    osInfo: Awaited<ReturnType<typeof si.osInfo>>
  }> | null = null

  constructor(
    private readonly provider: HostInformationProvider = si,
    private readonly cacheMilliseconds = 1_500,
  ) {}

  snapshot(): Promise<OpsHostSnapshot> {
    if (this.cached && Date.now() - this.cached.sampledAt <= this.cacheMilliseconds) {
      return Promise.resolve(this.cached.value)
    }
    if (this.inFlight) return this.inFlight
    const operation = this.collect().then(value => {
      this.cached = { value, sampledAt: Date.now() }
      return value
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null
    })
    this.inFlight = operation
    return operation
  }

  private async collect(): Promise<OpsHostSnapshot> {
    this.staticInformation ??= Promise.all([
      this.provider.cpu(),
      this.provider.osInfo(),
    ]).then(([cpu, osInfo]) => ({ cpu, osInfo }))
    const [staticInformation, load, memory, disks, time] = await Promise.all([
      this.staticInformation,
      this.provider.currentLoad(),
      this.provider.mem(),
      this.provider.fsSize(),
      Promise.resolve(this.provider.time()),
    ])
    const { cpu, osInfo } = staticInformation
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null
    if (!platform) throw new Error('Ops Gateway 只支持 Windows 与 Linux 主机。')
    return opsHostSnapshotSchema.parse({
      hostname: osInfo.hostname,
      platform,
      architecture: osInfo.arch,
      distribution: osInfo.distro || osInfo.platform,
      release: osInfo.release,
      uptimeSeconds: Math.max(0, time.uptime),
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        physicalCores: Math.max(1, cpu.physicalCores || cpu.cores),
        logicalCores: Math.max(1, cpu.cores),
        loadPercent: clampPercent(load.currentLoad),
      },
      memory: {
        totalBytes: memory.total,
        usedBytes: memory.used,
        availableBytes: memory.available,
        usedPercent: memory.total ? clampPercent(memory.used / memory.total * 100) : 0,
      },
      disks: disks.map(disk => ({
        filesystem: disk.fs,
        mount: disk.mount,
        totalBytes: disk.size,
        usedBytes: disk.used,
        availableBytes: disk.available,
        usedPercent: clampPercent(disk.use),
      })),
      sampledAt: new Date().toISOString(),
    })
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
}
