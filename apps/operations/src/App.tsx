// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台应用壳
//
//   文件:       App.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OpsBootstrap, OpsServiceAction, OpsServiceId } from '@geo-agent-platform/shared-types/operations'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  BookOpenCheck,
  FileClock,
  Files,
  LogOut,
  ScrollText,
  ServerCog,
  SquareTerminal,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'

import { opsControlClient } from './api/controlClient'
import { signOut } from './api/betterAuthClient.js'
import { OpsHttpError, opsHttp } from './api/http'
import { StatusPill } from './components/StatusPill'
import { StepUpDialog } from './components/StepUpDialog'
import { AccessDeniedPage, LoginPage } from './features/auth/LoginPage'
import { OverviewPage } from './features/overview/OverviewPage'
import { ServicesPage } from './features/services/ServicesPage'
import { useOpsStore } from './stores/opsStore'

const AuditPage = lazy(async () => ({ default: (await import('./features/audit/AuditPage')).AuditPage }))
const LogsPage = lazy(async () => ({ default: (await import('./features/logs/LogsPage')).LogsPage }))
const TerminalPage = lazy(async () => ({ default: (await import('./features/terminal/TerminalPage')).TerminalPage }))
const TranscriptsPage = lazy(async () => ({ default: (await import('./features/transcripts/TranscriptsPage')).TranscriptsPage }))

type PageId = 'overview' | 'services' | 'logs' | 'terminal' | 'transcripts' | 'audit'

const NAVIGATION: Array<{ id: PageId; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Activity size={15} /> },
  { id: 'services', label: '服务', icon: <ServerCog size={15} /> },
  { id: 'logs', label: '日志', icon: <ScrollText size={15} /> },
  { id: 'terminal', label: '终端', icon: <SquareTerminal size={15} /> },
  { id: 'transcripts', label: '记录', icon: <FileClock size={15} /> },
  { id: 'audit', label: '审计', icon: <BookOpenCheck size={15} /> },
]

export default function App() {
  const queryClient = useQueryClient()
  const bootstrapQuery = useQuery({ queryKey: ['ops-bootstrap'], queryFn: opsHttp.bootstrap, retry: false })
  const bootstrap = useOpsStore(state => state.bootstrap)
  const host = useOpsStore(state => state.host)
  const services = useOpsStore(state => state.services)
  const logs = useOpsStore(state => state.logs)
  const terminals = useOpsStore(state => state.terminals)
  const connected = useOpsStore(state => state.connected)
  const connectionMessage = useOpsStore(state => state.connectionMessage)
  const [page, setPage] = useState<PageId>(() => pageFromHash())
  const [stepUpOpen, setStepUpOpen] = useState(false)
  const [stepUpBusy, setStepUpBusy] = useState(false)
  const [stepUpError, setStepUpError] = useState<string | null>(null)
  const [pendingPrivilegedTask, setPendingPrivilegedTask] = useState<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (!bootstrapQuery.data) return
    useOpsStore.getState().setBootstrap(bootstrapQuery.data)
    opsControlClient.setAuth(bootstrapQuery.data.user.userId, bootstrapQuery.data.csrfToken)
  }, [bootstrapQuery.data])

  useEffect(() => {
    const stopPush = opsControlClient.onPush(event => {
      const store = useOpsStore.getState()
      if (event.type === 'host_snapshot') store.setHost(event.payload)
      if (event.type === 'service_snapshot') store.setServices(event.payload)
      if (event.type === 'log_entry') store.appendLog(event.payload)
      if (event.type === 'terminal_snapshot') store.upsertTerminal(event.payload)
    })
    const stopConnection = opsControlClient.onConnection((value, message) => {
      useOpsStore.getState().setConnection(value, message)
    })
    return () => { stopPush(); stopConnection() }
  }, [])

  useEffect(() => {
    if (!bootstrap) return
    void opsControlClient.subscribeMetrics().catch(() => undefined)
  }, [bootstrap?.user.userId])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const runPrivileged = useCallback((task: () => Promise<void>) => {
    const current = useOpsStore.getState().bootstrap
    const expiresAt = current?.stepUpExpiresAt ? Date.parse(current.stepUpExpiresAt) : 0
    if (expiresAt > Date.now() + 1_000) {
      void task()
      return
    }
    setPendingPrivilegedTask(() => task)
    setStepUpError(null)
    setStepUpOpen(true)
  }, [])

  const verifyStepUp = async (password: string) => {
    const current = useOpsStore.getState().bootstrap
    if (!current) return
    setStepUpBusy(true)
    setStepUpError(null)
    try {
      await opsHttp.stepUp(current, password)
      const refreshResult = await bootstrapQuery.refetch()
      if (!refreshResult.data) throw refreshResult.error ?? new Error('运维认证上下文刷新失败。')
      const refreshed = refreshResult.data
      useOpsStore.getState().setBootstrap(refreshed)
      opsControlClient.setAuth(refreshed.user.userId, refreshed.csrfToken)
      opsControlClient.refreshCredentials()
      const task = pendingPrivilegedTask
      setPendingPrivilegedTask(null)
      setStepUpOpen(false)
      if (task) await task()
    } catch (caught) {
      setStepUpError(caught instanceof Error ? caught.message : '密码验证失败。')
    } finally {
      setStepUpBusy(false)
    }
  }

  if (bootstrapQuery.isLoading) return <main className="ops-loading"><ServerCog size={24} /><strong>正在连接 Ops Gateway</strong><span>验证身份与监督器状态…</span></main>
  if (bootstrapQuery.error instanceof OpsHttpError && bootstrapQuery.error.status === 401) {
    return <LoginPage onSignedIn={async () => { await bootstrapQuery.refetch() }} />
  }
  if (bootstrapQuery.error instanceof OpsHttpError && bootstrapQuery.error.status === 403) return <AccessDeniedPage />
  if (bootstrapQuery.error || !bootstrap || !host) {
    const message = bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : '运维后台初始化失败。'
    return <main className="ops-loading ops-loading--error"><ServerCog size={24} /><strong>Ops Gateway 不可用</strong><span>{message}</span><button className="ops-button" onClick={() => { void bootstrapQuery.refetch() }}>重新连接</button></main>
  }

  const serviceAction = async (serviceId: OpsServiceId, action: OpsServiceAction, confirmation?: string) => {
    await opsControlClient.serviceAction(serviceId, action, confirmation)
  }
  return <div className="ops-shell">
    <header className="ops-header">
      <div className="ops-brand"><ServerCog size={18} /><strong>GeoForge</strong><span>运维控制台</span></div>
      <div className="ops-header__facts">
        {bootstrap.recoveryMode && <StatusPill value="数据库恢复模式" />}
        <span className={`ops-status-dot ops-status-dot--${connected ? 'good' : 'warn'}`} />
        <span title={connectionMessage ?? undefined}>{connected ? '实时连接正常' : '正在重连'}</span>
        <i />
        <span>{host.hostname}</span>
        <span>{bootstrap.user.displayName}</span>
        <button className="ops-icon-button" title="退出登录" onClick={() => {
          void signOut().then(() => {
            opsControlClient.setAuth(null, null)
            queryClient.clear()
            window.location.reload()
          })
        }}><LogOut size={14} /></button>
      </div>
    </header>
    <aside className="ops-sidebar">
      <div className="ops-sidebar__label">主机控制</div>
      <nav>{NAVIGATION.map(item => {
        const disabled = bootstrap.recoveryMode && !['overview', 'services'].includes(item.id)
        return <a
          key={item.id}
          href={`#${item.id}`}
          aria-current={page === item.id ? 'page' : undefined}
          aria-disabled={disabled}
          onClick={event => { if (disabled) event.preventDefault() }}
        >{item.icon}<span>{item.label}</span></a>
      })}</nav>
      <div className="ops-sidebar__footer"><Files size={14} /><div><strong>单机模式</strong><span>4 个固定服务</span></div></div>
    </aside>
    <main className="ops-main">
      {page === 'overview' && <OverviewPage host={host} services={services} />}
      {page === 'services' && <ServicesPage services={services} recoveryMode={bootstrap.recoveryMode} runPrivileged={runPrivileged} onAction={serviceAction} />}
      <Suspense fallback={<div className="ops-loading"><ServerCog size={20} /><strong>正在加载运维模块</strong></div>}>
        {page === 'logs' && !bootstrap.recoveryMode && <LogsPage logs={logs} onClear={useOpsStore.getState().clearLogs} />}
        {page === 'terminal' && !bootstrap.recoveryMode && <TerminalPage
          csrfToken={bootstrap.csrfToken}
          available={bootstrap.terminal.available}
          unavailableReason={bootstrap.terminal.unavailableReason}
          sessions={terminals}
          setSessions={useOpsStore.getState().setTerminals}
          upsertSession={useOpsStore.getState().upsertTerminal}
          runPrivileged={runPrivileged}
        />}
        {page === 'transcripts' && !bootstrap.recoveryMode && <TranscriptsPage bootstrap={bootstrap} runPrivileged={runPrivileged} />}
        {page === 'audit' && !bootstrap.recoveryMode && <AuditPage />}
      </Suspense>
    </main>
    <StepUpDialog open={stepUpOpen} busy={stepUpBusy} error={stepUpError} onOpenChange={open => { setStepUpOpen(open); if (!open) setPendingPrivilegedTask(null) }} onSubmit={password => { void verifyStepUp(password) }} />
  </div>
}

function pageFromHash(): PageId {
  const value = window.location.hash.slice(1)
  return NAVIGATION.some(item => item.id === value) ? value as PageId : 'overview'
}
