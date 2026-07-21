// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维审计页
//
//   文件:       AuditPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import type { ColumnDef } from '@tanstack/react-table'
import { ClipboardCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { opsHttp } from '../../api/http'
import { DataTable } from '../../components/DataTable'
import { StatusPill } from '../../components/StatusPill'

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void opsHttp.audit().then(setEvents).catch(caught => setError(caught instanceof Error ? caught.message : '审计事件加载失败。'))
  }, [])
  const columns = useMemo<ColumnDef<AuditEvent>[]>(() => [
    { header: '时间', cell: info => new Date(info.row.original.createdAt).toLocaleString('zh-CN') },
    { header: '动作', cell: info => <code>{info.row.original.action}</code> },
    { header: '结果', cell: info => <StatusPill value={info.row.original.outcome} /> },
    { header: '操作者', cell: info => <span className="ops-mono">{info.row.original.actorUserId ?? 'system'}</span> },
    { header: '对象', cell: info => <span className="ops-mono">{info.row.original.objectId ?? '—'}</span> },
    { header: '详情', cell: info => <code className="ops-metadata">{JSON.stringify(info.row.original.metadata)}</code> },
  ], [])
  return <div className="ops-page">
    <header className="ops-page__heading"><div><p>安全与可追溯性</p><h1>运维审计</h1></div><span className="ops-muted"><ClipboardCheck size={14} /> 最近 1,000 条运维事件</span></header>
    {error && <div className="ops-banner ops-banner--bad">{error}</div>}
    <section className="ops-panel"><DataTable data={events} columns={columns} getRowId={row => row.auditEventId} /></section>
  </div>
}
