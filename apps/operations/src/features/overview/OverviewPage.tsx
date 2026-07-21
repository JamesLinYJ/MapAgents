// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维总览
//
//   文件:       OverviewPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Activity, Cpu, Database, HardDrive, MemoryStick } from 'lucide-react'
import type { OpsHostSnapshot, OpsServiceSnapshot } from '@geo-agent-platform/shared-types/operations'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo } from 'react'

import { DataTable } from '../../components/DataTable'
import { StatusPill } from '../../components/StatusPill'
import { formatBytes, formatDuration, serviceStateLabel } from '../../shared/format'

export function OverviewPage({ host, services }: {
  host: OpsHostSnapshot
  services: OpsServiceSnapshot[]
}) {
  const columns = useMemo<ColumnDef<OpsServiceSnapshot>[]>(() => [
    { header: '服务', cell: info => <strong>{info.row.original.label}</strong> },
    { header: '状态', cell: info => <StatusPill value={serviceStateLabel(info.row.original.state)} /> },
    { header: '健康', cell: info => <StatusPill value={info.row.original.health} /> },
    { header: 'PID', cell: info => <span className="ops-mono">{info.row.original.pid ?? '—'}</span> },
    { header: '运行时间', cell: info => formatDuration(info.row.original.uptimeSeconds) },
    { header: '重启', accessorKey: 'restartCount' },
    { header: '内存', cell: info => formatBytes(info.row.original.memoryBytes) },
  ], [])
  const primaryDisk = host.disks[0]
  return (
    <div className="ops-page">
      <header className="ops-page__heading">
        <div><p>运行总览</p><h1>{host.hostname}</h1></div>
        <span className="ops-muted">采样于 {new Date(host.sampledAt).toLocaleTimeString('zh-CN')}</span>
      </header>

      <section className="ops-metric-strip" aria-label="主机指标">
        <Metric icon={<Cpu size={16} />} label="CPU" value={`${host.cpu.loadPercent.toFixed(1)}%`} detail={`${host.cpu.logicalCores} 逻辑核心`} percent={host.cpu.loadPercent} />
        <Metric icon={<MemoryStick size={16} />} label="内存" value={`${host.memory.usedPercent.toFixed(1)}%`} detail={`${formatBytes(host.memory.usedBytes)} / ${formatBytes(host.memory.totalBytes)}`} percent={host.memory.usedPercent} />
        <Metric icon={<HardDrive size={16} />} label="主磁盘" value={primaryDisk ? `${primaryDisk.usedPercent.toFixed(1)}%` : '—'} detail={primaryDisk ? `${formatBytes(primaryDisk.availableBytes)} 可用` : '未检测到磁盘'} percent={primaryDisk?.usedPercent ?? 0} />
        <Metric icon={<Activity size={16} />} label="主机运行" value={formatDuration(host.uptimeSeconds)} detail={`${host.distribution} ${host.release}`} />
      </section>

      <div className="ops-overview-grid">
        <section className="ops-panel">
          <div className="ops-panel__title"><Database size={15} /><strong>依赖拓扑</strong><span>固定服务集合</span></div>
          <div className="ops-topology" aria-label="服务依赖拓扑">
            {['infra', 'worker', 'api', 'web'].map((id, index) => {
              const service = services.find(item => item.id === id)
              return <div className="ops-topology__step" key={id}>
                <span className={`ops-status-dot ops-status-dot--${service?.health === 'healthy' ? 'good' : 'warn'}`} />
                <div><strong>{service?.label ?? id}</strong><small>{service?.description}</small></div>
                {index < 3 && <i>→</i>}
              </div>
            })}
          </div>
        </section>
        <section className="ops-panel ops-system-facts">
          <div className="ops-panel__title"><Cpu size={15} /><strong>系统信息</strong></div>
          <dl>
            <div><dt>平台</dt><dd>{host.platform} / {host.architecture}</dd></div>
            <div><dt>处理器</dt><dd>{host.cpu.manufacturer} {host.cpu.brand}</dd></div>
            <div><dt>物理核心</dt><dd>{host.cpu.physicalCores}</dd></div>
            <div><dt>磁盘卷</dt><dd>{host.disks.length}</dd></div>
          </dl>
        </section>
      </div>

      <section className="ops-panel">
        <div className="ops-panel__title"><Activity size={15} /><strong>服务健康</strong><span>{services.filter(item => item.health === 'healthy').length}/{services.length} 正常</span></div>
        <DataTable data={services} columns={columns} getRowId={row => row.id} />
      </section>
    </div>
  )
}

function Metric({ icon, label, value, detail, percent }: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
  percent?: number
}) {
  return <article className="ops-metric">
    <div className="ops-metric__label">{icon}<span>{label}</span></div>
    <strong>{value}</strong>
    <small>{detail}</small>
    {percent !== undefined && <div className="ops-meter"><i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>}
  </article>
}
