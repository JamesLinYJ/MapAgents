// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 多标签交互终端
//
//   文件:       TerminalPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { opsTerminalSessionSchema, type OpsTerminalSession } from '@geo-agent-platform/shared-types/operations'
import { Plus, SquareTerminal, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { opsControlClient } from '../../api/controlClient'
import { opsHttp } from '../../api/http'
import { StatusPill } from '../../components/StatusPill'
import { XtermPane } from './XtermPane'

export function TerminalPage({
  csrfToken,
  available,
  unavailableReason,
  sessions,
  setSessions,
  upsertSession,
  runPrivileged,
}: {
  csrfToken: string
  available: boolean
  unavailableReason: string | null
  sessions: OpsTerminalSession[]
  setSessions(value: OpsTerminalSession[]): void
  upsertSession(value: OpsTerminalSession): void
  runPrivileged(task: () => Promise<void>): void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [label, setLabel] = useState('运维终端')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openedIds, setOpenedIds] = useState<string[]>([])

  useEffect(() => {
    void opsHttp.terminals().then(setSessions).catch(caught => {
      setError(caught instanceof Error ? caught.message : '终端会话加载失败。')
    })
  }, [setSessions])

  useEffect(() => {
    const interactiveIds = sessions.filter(isInteractive).map(item => item.terminalId)
    if (!interactiveIds.length) return
    setOpenedIds(current => [...new Set([...current, ...interactiveIds])])
  }, [sessions])

  const visibleSessions = sessions.filter(item => openedIds.includes(item.terminalId) || isInteractive(item))
  const active = visibleSessions.find(item => item.terminalId === activeId) ?? null
  const create = () => runPrivileged(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = opsTerminalSessionSchema.parse(await opsControlClient.createTerminal(label, 120, 32))
      upsertSession(result)
      setOpenedIds(current => [result.terminalId, ...current.filter(id => id !== result.terminalId)])
      setActiveId(result.terminalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '终端创建失败。')
    } finally {
      setBusy(false)
    }
  })
  const close = (session: OpsTerminalSession) => runPrivileged(async () => {
    setBusy(true)
    try {
      const result = opsTerminalSessionSchema.parse(await opsControlClient.closeTerminal(session.terminalId))
      upsertSession(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '终端关闭失败。')
    } finally {
      setBusy(false)
    }
  })

  if (!available) return <div className="ops-page"><header className="ops-page__heading"><div><p>人工管理员专用</p><h1>交互终端</h1></div></header><div className="ops-empty-state"><SquareTerminal size={28} /><strong>终端不可用</strong><p>{unavailableReason}</p></div></div>

  return <div className="ops-page ops-page--terminal">
    <header className="ops-page__heading ops-page__heading--terminal">
      <div><p>人工管理员专用 · 不向 Agent 暴露</p><h1>交互终端</h1></div>
      <div className="ops-inline-form">
        <input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} aria-label="新终端名称" />
        <button className="ops-button ops-button--primary" disabled={!label.trim() || busy} onClick={create}><Plus size={14} />新建终端</button>
      </div>
    </header>
    {error && <div className="ops-banner ops-banner--bad">{error}</div>}
    <div className="ops-terminal-tabs" role="tablist">
      {visibleSessions.map(session => <div className={`ops-terminal-tab ${activeId === session.terminalId ? 'is-active' : ''}`} key={session.terminalId}>
        <button
          role="tab"
          aria-selected={activeId === session.terminalId}
          onClick={() => setActiveId(session.terminalId)}
        >
          <SquareTerminal size={13} /><span>{session.label}</span><StatusPill value={session.state} />
        </button>
        {isInteractive(session) ? <button
          className="ops-terminal-tab__close"
          aria-label={`关闭 ${session.label}`}
          title="关闭终端"
          onClick={() => close(session)}
        ><X size={12} /></button> : <button
          className="ops-terminal-tab__close"
          aria-label={`移除 ${session.label}`}
          title="从标签栏移除"
          onClick={() => {
            setOpenedIds(current => current.filter(id => id !== session.terminalId))
            if (activeId === session.terminalId) setActiveId(null)
          }}
        ><X size={12} /></button>}
      </div>)}
      {!visibleSessions.length && <span className="ops-muted">尚无运行中的终端会话</span>}
    </div>
    <div className="ops-terminal-stage">
      {active && isInteractive(active)
        ? <XtermPane key={active.terminalId} session={active} csrfToken={csrfToken} onState={upsertSession} />
        : active
          ? <div className="ops-empty-state"><SquareTerminal size={28} /><strong>终端会话已结束</strong><p>状态：{active.state} · 退出码：{active.exitCode ?? '未提供'}。完整输出请到“记录”页回放。</p></div>
          : <div className="ops-empty-state"><SquareTerminal size={28} /><strong>选择或新建终端</strong><p>断线后 PTY 会保留 30 分钟；录制仅包含输出和尺寸变化。</p></div>}
    </div>
  </div>
}

function isInteractive(session: OpsTerminalSession): boolean {
  return ['starting', 'running', 'detached'].includes(session.state)
}
