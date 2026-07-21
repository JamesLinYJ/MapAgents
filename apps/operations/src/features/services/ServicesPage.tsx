// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 服务管理页
//
//   文件:       ServicesPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Play, RefreshCw, Square } from 'lucide-react'
import type {
  OpsServiceAction,
  OpsServiceId,
  OpsServiceSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { useState } from 'react'

import { PromptDialog } from '../../components/PromptDialog'
import { StatusPill } from '../../components/StatusPill'
import { formatBytes, formatDuration, serviceStateLabel } from '../../shared/format'

interface PendingAction {
  service: OpsServiceSnapshot
  action: OpsServiceAction
}

export function ServicesPage({
  services,
  recoveryMode,
  runPrivileged,
  onAction,
}: {
  services: OpsServiceSnapshot[]
  recoveryMode: boolean
  runPrivileged(task: () => Promise<void>): void
  onAction(serviceId: OpsServiceId, action: OpsServiceAction, confirmation?: string): Promise<void>
}) {
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const execute = (service: OpsServiceSnapshot, action: OpsServiceAction, confirmation?: string) => {
    const task = async () => {
      setBusy(`${service.id}:${action}`)
      setError(null)
      try {
        await onAction(service.id, action, confirmation)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '服务操作失败。')
      } finally {
        setBusy(null)
      }
    }
    if (recoveryMode && service.id === 'infra' && ['start', 'restart'].includes(action)) void task()
    else runPrivileged(task)
  }

  const request = (service: OpsServiceSnapshot, action: OpsServiceAction) => {
    if (action === 'start') execute(service, action)
    else setPending({ service, action })
  }

  return <div className="ops-page">
    <header className="ops-page__heading">
      <div><p>进程监督</p><h1>服务管理</h1></div>
      <span className="ops-muted">Process Compose 1.120.0 是唯一状态事实源</span>
    </header>
    {recoveryMode && <div className="ops-banner ops-banner--warn">数据库恢复模式：仅允许启动或重启 infra；其余写操作已禁用。</div>}
    {error && <div className="ops-banner ops-banner--bad">{error}</div>}
    <div className="ops-service-list">
      {services.map(service => <article className="ops-service-row" key={service.id}>
        <div className="ops-service-row__identity">
          <span className={`ops-status-dot ops-status-dot--${service.health === 'healthy' ? 'good' : 'warn'}`} />
          <div><strong>{service.label}</strong><small>{service.description}</small></div>
        </div>
        <div className="ops-service-row__facts">
          <span><small>状态</small><StatusPill value={serviceStateLabel(service.state)} /></span>
          <span><small>PID</small><b className="ops-mono">{service.pid ?? '—'}</b></span>
          <span><small>运行</small><b>{formatDuration(service.uptimeSeconds)}</b></span>
          <span><small>内存</small><b>{formatBytes(service.memoryBytes)}</b></span>
          <span><small>重启</small><b>{service.restartCount}</b></span>
        </div>
        <div className="ops-service-row__actions">
          <button className="ops-icon-button" title="启动" disabled={busy !== null || service.state === 'running'} onClick={() => request(service, 'start')}><Play size={15} /></button>
          <button className="ops-icon-button" title="重启" disabled={busy !== null || (recoveryMode && service.id !== 'infra')} onClick={() => request(service, 'restart')}><RefreshCw size={15} /></button>
          <button className="ops-icon-button ops-icon-button--danger" title="停止" disabled={busy !== null || recoveryMode} onClick={() => request(service, 'stop')}><Square size={14} /></button>
        </div>
        {service.dependencies.length > 0 && <div className="ops-service-row__dependency">依赖：{service.dependencies.join(' → ')}</div>}
      </article>)}
    </div>
    <PromptDialog
      open={Boolean(pending)}
      title={`${pending?.action === 'stop' ? '停止' : '重启'} ${pending?.service.label ?? ''}`}
      description={pending?.service.id === 'infra'
        ? '这会中断 PostgreSQL/PostGIS、Martin 和 TiTiler，并影响所有依赖服务。'
        : `这会暂时中断 ${pending?.service.label ?? '服务'} 及其下游能力。`}
      label={pending?.service.id === 'infra' ? '输入 infra 继续' : '输入“确认”继续'}
      placeholder={pending?.service.id === 'infra' ? 'infra' : '确认'}
      confirmText={pending?.action === 'stop' ? '确认停止' : '确认重启'}
      danger
      validate={value => value === (pending?.service.id === 'infra' ? 'infra' : '确认')}
      onOpenChange={open => { if (!open) setPending(null) }}
      onConfirm={() => {
        if (!pending) return
        const confirmation = pending.service.id === 'infra' ? 'infra' : 'confirmed'
        execute(pending.service, pending.action, confirmation)
        setPending(null)
      }}
    />
  </div>
}
