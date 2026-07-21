// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 加密终端记录页
//
//   文件:       TranscriptsPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OpsBootstrap, OpsTranscriptSummary } from '@geo-agent-platform/shared-types/operations'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, Play, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { opsHttp } from '../../api/http'
import { DataTable } from '../../components/DataTable'
import { PromptDialog } from '../../components/PromptDialog'
import { StatusPill } from '../../components/StatusPill'
import { formatBytes } from '../../shared/format'
import { ReplayPane } from './ReplayPane'

type AccessMode = 'replay' | 'download'

export function TranscriptsPage({ bootstrap, runPrivileged }: {
  bootstrap: OpsBootstrap
  runPrivileged(task: () => Promise<void>): void
}) {
  const [records, setRecords] = useState<OpsTranscriptSummary[]>([])
  const [selected, setSelected] = useState<{ terminalId: string; grantId?: string } | null>(null)
  const [request, setRequest] = useState<{ record: OpsTranscriptSummary; mode: AccessMode } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void opsHttp.transcripts().then(setRecords).catch(caught => setError(caught instanceof Error ? caught.message : '终端记录加载失败。'))
  }, [])

  const open = (record: OpsTranscriptSummary, mode: AccessMode) => {
    if (!record.ownedByRequester) {
      setRequest({ record, mode })
      return
    }
    finishAccess(record.terminalId, mode)
  }
  const finishAccess = (terminalId: string, mode: AccessMode, grantId?: string) => {
    if (mode === 'replay') {
      setSelected({ terminalId, ...(grantId === undefined ? {} : { grantId }) })
      return
    }
    const query = new URLSearchParams({ download: '1', ...(grantId === undefined ? {} : { grant: grantId }) })
    const link = document.createElement('a')
    link.href = `/ops/api/v1/transcripts/${encodeURIComponent(terminalId)}/cast?${query}`
    link.click()
  }

  const columns = useMemo<ColumnDef<OpsTranscriptSummary>[]>(() => [
    { header: '记录', cell: info => <div><strong>{info.row.original.label}</strong><small className="ops-cell-sub">{info.row.original.terminalId}</small></div> },
    { header: '创建者', cell: info => info.row.original.ownerDisplayName },
    { header: '状态', cell: info => <StatusPill value={info.row.original.state} /> },
    { header: '分块', accessorKey: 'chunkCount' },
    { header: '密文大小', cell: info => formatBytes(info.row.original.sizeBytes) },
    { header: '创建时间', cell: info => new Date(info.row.original.createdAt).toLocaleString('zh-CN') },
    { header: '保留至', cell: info => new Date(info.row.original.retainedUntil).toLocaleString('zh-CN') },
    { id: 'actions', header: '', cell: info => <div className="ops-row-actions">
      <button className="ops-icon-button" title="回放" onClick={() => open(info.row.original, 'replay')}><Play size={14} /></button>
      <button className="ops-icon-button" title="导出 .cast" onClick={() => open(info.row.original, 'download')}><Download size={14} /></button>
    </div> },
  ], [])

  return <div className="ops-page">
    <header className="ops-page__heading">
      <div><p>AES-256-GCM · asciicast v2</p><h1>终端记录</h1></div>
      <span className="ops-muted"><ShieldCheck size={14} /> 默认保留 7 天；不记录原始键盘输入</span>
    </header>
    {error && <div className="ops-banner ops-banner--bad">{error}</div>}
    <section className="ops-panel"><DataTable data={records} columns={columns} getRowId={row => row.terminalId} /></section>
    {selected && <ReplayPane terminalId={selected.terminalId} {...(selected.grantId === undefined ? {} : { grantId: selected.grantId })} />}
    <PromptDialog
      open={Boolean(request)}
      title="申请查阅他人终端记录"
      description="访问授权仅可使用一次，并在 5 分钟后失效；原因和访问结果会写入独立审计事件。"
      label="查阅原因（至少 10 个字符）"
      placeholder="例如：调查 14:30 API 重启失败"
      confirmText="验证身份并授权"
      validate={value => value.trim().length >= 10 && value.trim().length <= 500}
      onOpenChange={open => { if (!open) setRequest(null) }}
      onConfirm={reason => {
        const current = request
        if (!current) return
        setRequest(null)
        runPrivileged(async () => {
          try {
            const grant = await opsHttp.grantTranscriptAccess(bootstrap, current.record.terminalId, reason)
            finishAccess(current.record.terminalId, current.mode, grant.grantId)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : '记录访问授权失败。')
          }
        })
      }}
    />
  </div>
}
