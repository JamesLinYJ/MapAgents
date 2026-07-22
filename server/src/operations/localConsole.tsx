// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 中文本地运维台
//
//   文件:       localConsole.tsx
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ConfirmInput, PasswordInput, TextInput, ThemeProvider } from '@inkjs/ui'
import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import type {
  OperationsLogEntry,
  OperationsOperationResult,
  OperationsServiceId,
  OperationsServiceSnapshot,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink'

import type { LocalManagedAccount } from '../store/postgres/localAccountRepository.js'
import { consolePalette, geoForgeConsoleTheme } from './localConsoleTheme.js'
import type { LocalConsoleDataPlane, LocalConsoleOptions, LocalConsoleTab } from './localConsoleTypes.js'

const ALL_SERVICES: OperationsServiceId[] = ['infra', 'worker', 'api', 'web']
const TAB_ORDER: LocalConsoleTab[] = ['services', 'logs', 'accounts', 'audit']
const LOG_LEVELS = ['all', 'error', 'warn', 'info', 'debug', 'unknown'] as const
type LogLevelFilter = (typeof LOG_LEVELS)[number]

type AccountAction = 'grant' | 'revoke' | 'enable' | 'disable' | 'sessions'
type ConsoleDialog =
  | { kind: 'help' }
  | { kind: 'search' }
  | { kind: 'confirm'; title: string; detail: string; expected: string | null; execute: () => Promise<void> }
  | {
      kind: 'create'
      step: 'email' | 'name' | 'password' | 'repeat' | 'confirm'
      email: string
      name: string
      password: string
    }
  | {
      kind: 'password'
      step: 'password' | 'repeat' | 'confirm'
      targetEmail: string
      password: string
    }

export async function runLocalConsole(options: LocalConsoleOptions): Promise<void> {
  const instance = render(
    <ThemeProvider theme={geoForgeConsoleTheme}>
      <LocalConsoleApp options={options} />
    </ThemeProvider>,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await instance.waitUntilExit()
}

export function LocalConsoleApp({ options }: { options: LocalConsoleOptions }) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [tab, setTab] = useState<LocalConsoleTab>('services')
  const [client, setClient] = useState<OperationsClient | null>(null)
  const [connection, setConnection] = useState('正在连接监督器…')
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [logs, setLogs] = useState<OperationsLogEntry[]>([])
  const [serviceIndex, setServiceIndex] = useState(0)
  const [accountIndex, setAccountIndex] = useState(0)
  const [auditIndex, setAuditIndex] = useState(0)
  const [accounts, setAccounts] = useState<LocalManagedAccount[]>([])
  const [audits, setAudits] = useState<AuditEvent[]>([])
  const [dataPlaneError, setDataPlaneError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('就绪。q / Ctrl+C 仅分离，不停止服务。')
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ConsoleDialog | null>(null)
  const [search, setSearch] = useState('')
  const [logPaused, setLogPaused] = useState(false)
  const [pausedSequence, setPausedSequence] = useState<number | null>(null)
  const [logLevel, setLogLevel] = useState<LogLevelFilter>('all')
  const [logService, setLogService] = useState<OperationsServiceId | 'all'>('all')
  const [wrapLogs, setWrapLogs] = useState(false)
  const [showInspector, setShowInspector] = useState(false)
  const dataPlaneRef = useRef<Promise<LocalConsoleDataPlane> | null>(null)

  const ensureDataPlane = useCallback((): Promise<LocalConsoleDataPlane> => {
    dataPlaneRef.current ??= options.openDataPlane().catch(error => {
      dataPlaneRef.current = null
      throw error
    })
    return dataPlaneRef.current
  }, [options])

  const loadAccounts = useCallback(async (): Promise<void> => {
    try {
      const plane = await ensureDataPlane()
      const next = await plane.accounts.listAccounts()
      setAccounts(next)
      setAccountIndex(index => clampIndex(index, next.length))
      setDataPlaneError(null)
    } catch (error) {
      setDataPlaneError(`账户数据不可用：${safeMessage(error)}`)
    }
  }, [ensureDataPlane])

  const loadAudits = useCallback(async (): Promise<void> => {
    try {
      const plane = await ensureDataPlane()
      const next = await plane.listAuditEvents(300)
      setAudits(next)
      setAuditIndex(index => clampIndex(index, next.length))
      setDataPlaneError(null)
    } catch (error) {
      setDataPlaneError(`审计数据不可用：${safeMessage(error)}`)
    }
  }, [ensureDataPlane])

  useEffect(() => {
    if (tab === 'accounts') void loadAccounts()
    if (tab === 'audit') void loadAudits()
  }, [loadAccounts, loadAudits, tab])

  useEffect(() => () => {
    const pending = dataPlaneRef.current
    if (pending) void pending.then(plane => plane.close()).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    let activeClient: OperationsClient | null = null
    let reconnectTimer: NodeJS.Timeout | null = null
    const connect = async (): Promise<void> => {
      setConnection('正在连接监督器…')
      try {
        const next = await options.connectSupervisor()
        if (cancelled) {
          next.close()
          return
        }
        activeClient = next
        setClient(next)
        setConnection('已连接')
        const disposeEvents = next.onEvent(event => {
          if (event.event === 'snapshot') setSnapshot(event.snapshot)
          if (event.event === 'log') setLogs(current => [...current, event.entry].slice(-1_500))
          if (event.event === 'operation') setFeedback(operationFeedback(event.operation))
        })
        const disposeDisconnected = next.onDisconnected(error => {
          disposeEvents()
          disposeDisconnected()
          if (cancelled) return
          activeClient = null
          setClient(null)
          setConnection(`连接中断：${safeMessage(error)}；2 秒后重连`)
          reconnectTimer = setTimeout(() => void connect(), 2_000)
        })
        const [initialSnapshot, initialLogs] = await Promise.all([
          next.status(),
          next.logs(ALL_SERVICES, 300),
        ])
        if (cancelled || activeClient !== next) return
        setSnapshot(initialSnapshot)
        setLogs(initialLogs)
        await next.subscribe({ metrics: true, logs: true })
      } catch (error) {
        if (cancelled) return
        setConnection(`无法连接：${safeMessage(error)}；2 秒后重试`)
        reconnectTimer = setTimeout(() => void connect(), 2_000)
      }
    }
    void connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      activeClient?.close()
    }
  }, [options])

  const selectedService = snapshot?.services[serviceIndex] ?? null
  const selectedAccount = accounts[accountIndex] ?? null

  const runOperation = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label)
    try {
      await action()
      setFeedback(`${label}完成。`)
    } catch (error) {
      setFeedback(`${label}失败：${safeMessage(error)}`)
    } finally {
      setBusy(null)
      setDialog(null)
    }
  }, [])

  const executeServiceAction = useCallback(async (
    action: 'start' | 'stop' | 'restart',
    service: OperationsServiceSnapshot,
  ): Promise<void> => {
    if (!client) throw new Error('监督器尚未连接。')
    const result = await client.operate({ action, target: service.serviceId })
    assertOperationSucceeded(result)
    setFeedback(operationFeedback(result))
  }, [client])

  const requestServiceAction = useCallback((action: 'start' | 'stop' | 'restart'): void => {
    if (!selectedService) {
      setFeedback('尚未取得服务状态。')
      return
    }
    if (action === 'start') {
      void runOperation(`启动${selectedService.displayName}`, () => executeServiceAction(action, selectedService))
      return
    }
    const dangerous = selectedService.serviceId === 'infra'
    setDialog({
      kind: 'confirm',
      title: `${action === 'stop' ? '停止' : '重启'} ${selectedService.displayName}`,
      detail: serviceImpact(selectedService, snapshot),
      expected: dangerous ? selectedService.displayName : null,
      execute: () => runOperation(
        `${action === 'stop' ? '停止' : '重启'}${selectedService.displayName}`,
        () => executeServiceAction(action, selectedService),
      ),
    })
  }, [executeServiceAction, runOperation, selectedService, snapshot])

  const refreshAccountViews = useCallback(async (): Promise<void> => {
    await loadAccounts()
    if (tab === 'audit') await loadAudits()
  }, [loadAccounts, loadAudits, tab])

  const executeAccountAction = useCallback(async (
    action: AccountAction,
    account: LocalManagedAccount,
  ): Promise<void> => {
    const plane = await ensureDataPlane()
    if (action === 'grant') await plane.accounts.grantPlatformAdmin(account.email)
    if (action === 'revoke') await plane.accounts.revokePlatformAdmin(account.email)
    if (action === 'enable') await plane.accounts.setAccountEnabled(account.email, true)
    if (action === 'disable') await plane.accounts.setAccountEnabled(account.email, false)
    if (action === 'sessions') await plane.accounts.revokeSessions(account.email)
    await refreshAccountViews()
  }, [ensureDataPlane, refreshAccountViews])

  const requestAccountAction = useCallback((action: AccountAction): void => {
    if (!selectedAccount) {
      setFeedback('当前没有可操作的认证账户。')
      return
    }
    if (action === 'enable') {
      void runOperation(`启用 ${selectedAccount.email}`, () => executeAccountAction(action, selectedAccount))
      return
    }
    const labels: Record<Exclude<AccountAction, 'enable'>, string> = {
      grant: '授予平台管理员',
      revoke: '撤销平台管理员',
      disable: '禁用账户并撤销会话',
      sessions: '撤销全部登录会话',
    }
    const dangerous = action === 'revoke' || action === 'disable'
    setDialog({
      kind: 'confirm',
      title: `${labels[action]} · ${selectedAccount.email}`,
      detail: dangerous ? '此操作会立即改变权限或登录状态，并写入本机运维审计。' : '操作将通过 Better Auth 官方 Admin API 执行。',
      expected: dangerous ? selectedAccount.email : null,
      execute: () => runOperation(labels[action], () => executeAccountAction(action, selectedAccount)),
    })
  }, [executeAccountAction, runOperation, selectedAccount])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }
    if (input === 'q') {
      exit()
      return
    }
    if (input === 'Q') {
      setDialog({
        kind: 'confirm',
        title: '停止全部服务并关闭监督器',
        detail: '这与普通分离不同：所有服务都会停止，监督后台也会退出。',
        expected: '停止全部',
        execute: () => runOperation('停止全部并退出', async () => {
          if (!client) throw new Error('监督器尚未连接。')
          assertOperationSucceeded(await client.shutdown())
          exit()
        }),
      })
      return
    }
    if (input === '?') {
      setDialog({ kind: 'help' })
      return
    }
    if (/^[1-4]$/u.test(input)) {
      const next = TAB_ORDER[Number(input) - 1]
      if (next) setTab(next)
      return
    }
    if (key.upArrow) {
      if (tab === 'services') setServiceIndex(index => Math.max(0, index - 1))
      if (tab === 'accounts') setAccountIndex(index => Math.max(0, index - 1))
      if (tab === 'audit') setAuditIndex(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      if (tab === 'services') setServiceIndex(index => Math.min((snapshot?.services.length ?? 1) - 1, index + 1))
      if (tab === 'accounts') setAccountIndex(index => Math.min(Math.max(0, accounts.length - 1), index + 1))
      if (tab === 'audit') setAuditIndex(index => Math.min(Math.max(0, audits.length - 1), index + 1))
      return
    }
    if (tab === 'services') {
      if (key.return) setShowInspector(value => !value)
      if (input.toLowerCase() === 's') requestServiceAction('start')
      if (input.toLowerCase() === 'x') requestServiceAction('stop')
      if (input.toLowerCase() === 'r') requestServiceAction('restart')
    }
    if (tab === 'logs' || tab === 'services') {
      if (input === '/') setDialog({ kind: 'search' })
      if (input.toLowerCase() === 'f') {
        setLogPaused(value => {
          const next = !value
          setPausedSequence(next ? (logs.at(-1)?.sequence ?? 0) : null)
          return next
        })
      }
      if (input.toLowerCase() === 'w') setWrapLogs(value => !value)
      if (input.toLowerCase() === 'l') {
        setLogLevel(value => LOG_LEVELS[(LOG_LEVELS.indexOf(value) + 1) % LOG_LEVELS.length] ?? 'all')
      }
      if (input === '[' || input === ']') setLogService(value => cycleService(value, input === ']' ? 1 : -1))
    }
    if (tab === 'accounts') {
      if (input.toLowerCase() === 'u') void loadAccounts()
      if (input.toLowerCase() === 'n') setDialog({ kind: 'create', step: 'email', email: '', name: '', password: '' })
      if (input.toLowerCase() === 'g') requestAccountAction('grant')
      if (input.toLowerCase() === 'x') requestAccountAction('revoke')
      if (input.toLowerCase() === 'e' && selectedAccount) {
        requestAccountAction(selectedAccount.banned || selectedAccount.platformStatus === 'disabled' ? 'enable' : 'disable')
      }
      if (input.toLowerCase() === 'v') requestAccountAction('sessions')
      if (input.toLowerCase() === 'p' && selectedAccount) {
        setDialog({ kind: 'password', step: 'password', targetEmail: selectedAccount.email, password: '' })
      }
    }
    if (tab === 'audit' && input.toLowerCase() === 'u') void loadAudits()
  }, { isActive: dialog === null && busy === null })

  const visibleLogs = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return logs.filter(entry => {
      if (pausedSequence !== null && entry.sequence > pausedSequence) return false
      if (logService !== 'all' && entry.serviceId !== logService) return false
      if (logLevel !== 'all' && entry.level !== logLevel) return false
      return !normalizedSearch || entry.message.toLowerCase().includes(normalizedSearch)
    })
  }, [logLevel, logService, logs, pausedSequence, search])

  const submitCreate = useCallback((value: string): void => {
    if (!dialog || dialog.kind !== 'create') return
    if (dialog.step === 'email') {
      setDialog({ ...dialog, email: value.trim().toLowerCase(), step: 'name' })
    } else if (dialog.step === 'name') {
      setDialog({ ...dialog, name: value.trim(), step: 'password' })
    } else if (dialog.step === 'password') {
      setDialog({ ...dialog, password: value, step: 'repeat' })
    } else if (dialog.step === 'repeat') {
      if (value !== dialog.password) {
        setFeedback('两次输入的密码不一致。')
        setDialog({ ...dialog, password: '', step: 'password' })
      } else {
        setDialog({ ...dialog, step: 'confirm' })
      }
    } else if (value.trim().toLowerCase() === dialog.email) {
      void runOperation(`创建管理员 ${dialog.email}`, async () => {
        const plane = await ensureDataPlane()
        await plane.accounts.createPlatformAdmin({
          email: dialog.email,
          password: dialog.password,
          displayName: dialog.name,
        })
        await refreshAccountViews()
      })
    } else {
      setFeedback('确认邮箱不匹配，操作未执行。')
    }
  }, [dialog, ensureDataPlane, refreshAccountViews, runOperation])

  const submitPassword = useCallback((value: string): void => {
    if (!dialog || dialog.kind !== 'password') return
    if (dialog.step === 'password') {
      setDialog({ ...dialog, password: value, step: 'repeat' })
    } else if (dialog.step === 'repeat') {
      if (value !== dialog.password) {
        setFeedback('两次输入的密码不一致。')
        setDialog({ ...dialog, password: '', step: 'password' })
      } else {
        setDialog({ ...dialog, step: 'confirm' })
      }
    } else if (value.trim().toLowerCase() === dialog.targetEmail) {
      void runOperation(`重置 ${dialog.targetEmail} 的密码`, async () => {
        const plane = await ensureDataPlane()
        await plane.accounts.resetPassword(dialog.targetEmail, dialog.password)
        await refreshAccountViews()
      })
    } else {
      setFeedback('确认邮箱不匹配，操作未执行。')
    }
  }, [dialog, ensureDataPlane, refreshAccountViews, runOperation])

  if (columns < 80 || rows < 24) {
    return <SizeWarning columns={columns} rows={rows} onExit={exit} />
  }

  return (
    <Box width={columns} height={rows} flexDirection="column" backgroundColor={tone(consolePalette.canvas)}>
      <ConsoleHeader snapshot={snapshot} connection={connection} />
      <TabBar active={tab} />
      <Box flexGrow={1} paddingX={1} paddingY={1}>
        {dialog
          ? <DialogView
              dialog={dialog}
              minPasswordLength={options.minPasswordLength}
              onCancel={() => setDialog(null)}
              onSearch={value => { setSearch(value); setDialog(null) }}
              onCreateSubmit={submitCreate}
              onPasswordSubmit={submitPassword}
            />
          : tab === 'services'
            ? <ServicesView
                snapshot={snapshot}
                selectedIndex={serviceIndex}
                logs={visibleLogs}
                columns={columns}
                rows={rows}
                showInspector={showInspector}
                wrapLogs={wrapLogs}
              />
            : tab === 'logs'
              ? <LogsView
                  entries={visibleLogs}
                  rows={rows - 8}
                  paused={logPaused}
                  search={search}
                  level={logLevel}
                  service={logService}
                  wrap={wrapLogs}
                />
              : tab === 'accounts'
                ? <AccountsView accounts={accounts} selectedIndex={accountIndex} error={dataPlaneError} />
                : <AuditView audits={audits} selectedIndex={auditIndex} error={dataPlaneError} />}
      </Box>
      <ConsoleFooter tab={tab} feedback={busy ?? feedback} />
    </Box>
  )
}

function ConsoleHeader({ snapshot, connection }: { snapshot: OperationsSnapshot | null; connection: string }) {
  return (
    <Box borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1} justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color={tone(consolePalette.focus)}>◆ GeoForge 本地运维台</Text>
        <Text color={tone(consolePalette.muted)}>
          {snapshot ? `${snapshot.host.hostname} · ${snapshot.host.profile === 'production' ? '生产' : '开发'} · 监督 PID ${snapshot.host.supervisorPid}` : '等待监督状态'}
        </Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text color={tone(connection === '已连接' ? consolePalette.healthy : consolePalette.warning)}>
          {connection === '已连接' ? '● 已连接' : `◐ ${connection}`}
        </Text>
        <Text color={tone(consolePalette.text)}>
          主机 CPU {formatMetric(snapshot?.host.cpuPercent.value ?? null, '%')} · 内存 {formatPercent(snapshot?.host.memoryUsedBytes.value ?? null, snapshot?.host.memoryTotalBytes.value ?? null)} · 磁盘 {formatPercent(snapshot?.host.runtimeDiskUsedBytes.value ?? null, snapshot?.host.runtimeDiskTotalBytes.value ?? null)}
        </Text>
      </Box>
    </Box>
  )
}

function TabBar({ active }: { active: LocalConsoleTab }) {
  const labels: Array<[LocalConsoleTab, string]> = [
    ['services', '1 服务'], ['logs', '2 日志'], ['accounts', '3 账户'], ['audit', '4 审计'],
  ]
  return (
    <Box paddingX={2} gap={1}>
      {labels.map(([tab, label]) => (
        <Text
          key={tab}
          bold={active === tab}
          color={tone(active === tab ? consolePalette.canvas : consolePalette.muted)}
          backgroundColor={tone(active === tab ? consolePalette.focus : consolePalette.panel)}
        > {label} </Text>
      ))}
      <Box flexGrow={1} />
      <Text color={tone(consolePalette.muted)}>? 帮助</Text>
    </Box>
  )
}

function ServicesView(input: {
  snapshot: OperationsSnapshot | null
  selectedIndex: number
  logs: OperationsLogEntry[]
  columns: number
  rows: number
  showInspector: boolean
  wrapLogs: boolean
}) {
  const services = input.snapshot?.services ?? []
  const selected = services[input.selectedIndex] ?? null
  const wide = input.columns >= 140
  const showInspector = wide || input.showInspector
  const logRows = Math.max(5, input.rows - 20)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box minHeight={9}>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
          <ServiceTableHeader wide={wide} />
          {services.length
            ? services.map((service, index) => <ServiceRow key={service.serviceId} service={service} selected={index === input.selectedIndex} wide={wide} />)
            : <Text color={tone(consolePalette.warning)}>◐ 正在等待监督器快照…</Text>}
        </Box>
        {showInspector && <ServiceInspector service={selected} width={wide ? 46 : 38} />}
      </Box>
      <Box marginTop={1} flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
        <Text bold color={tone(consolePalette.focus)}>实时日志 · 最近 {Math.min(input.logs.length, logRows)} 行</Text>
        <LogLines entries={input.logs.slice(-logRows)} wrap={input.wrapLogs} />
      </Box>
    </Box>
  )
}

function ServiceTableHeader({ wide }: { wide: boolean }) {
  return (
    <Box>
      <Cell width={13} muted>状态</Cell><Cell width={15} muted>服务</Cell><Cell width={8} muted>PID</Cell>
      <Cell width={10} muted>CPU</Cell><Cell width={12} muted>内存</Cell>
      {wide && <><Cell width={12} muted>运行时间</Cell><Cell width={7} muted>重启</Cell></>}
      <Cell muted>健康</Cell>
    </Box>
  )
}

function ServiceRow({ service, selected, wide }: { service: OperationsServiceSnapshot; selected: boolean; wide: boolean }) {
  const presentation = servicePresentation(service)
  return (
    <Box backgroundColor={tone(selected ? consolePalette.selected : consolePalette.canvas)}>
      <Cell width={13} color={presentation.color}>{presentation.symbol} {presentation.label}</Cell>
      <Cell width={15} bold={selected}>{service.displayName}</Cell>
      <Cell width={8}>{service.pid ?? '—'}</Cell>
      <Cell width={10}>{formatMetric(service.cpuPercent.value, '%')}</Cell>
      <Cell width={12}>{formatBytes(service.memoryBytes.value)}</Cell>
      {wide && <><Cell width={12}>{formatDuration(service.uptimeSeconds)}</Cell><Cell width={7}>{service.restartCount}</Cell></>}
      <Cell color={service.state === 'healthy' ? consolePalette.muted : presentation.color}>{service.healthMessage}</Cell>
    </Box>
  )
}

function ServiceInspector({ service, width }: { service: OperationsServiceSnapshot | null; width: number }) {
  return (
    <Box width={width} marginLeft={1} flexDirection="column" borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
      <Text bold color={tone(consolePalette.focus)}>服务检查器</Text>
      {service
        ? <>
            <Text bold>{service.displayName}</Text>
            <Text color={tone(consolePalette.muted)}>{service.description}</Text>
            <Text>状态：{servicePresentation(service).label}</Text>
            <Text>依赖阻塞：{service.blockedBy.length ? service.blockedBy.join('、') : '无'}</Text>
            <Text>容器：{service.containers.length || '无'}</Text>
            {service.containers.slice(0, 4).map(container => (
              <Text key={container.containerId} color={tone(consolePalette.muted)}>
                • {container.serviceName} · {formatMetric(container.cpuPercent.value, '% 核心')} · {formatBytes(container.memoryBytes.value)}
              </Text>
            ))}
          </>
        : <Text color={tone(consolePalette.muted)}>选择服务后显示探针与容器摘要。</Text>}
    </Box>
  )
}

function LogsView(input: {
  entries: OperationsLogEntry[]
  rows: number
  paused: boolean
  search: string
  level: LogLevelFilter
  service: OperationsServiceId | 'all'
  wrap: boolean
}) {
  const visible = input.entries.slice(-Math.max(3, input.rows - 4))
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
      <Box gap={2}>
        <Text color={tone(input.paused ? consolePalette.warning : consolePalette.healthy)}>{input.paused ? 'Ⅱ 已暂停' : '▶ 实时跟随'}</Text>
        <Text color={tone(consolePalette.muted)}>服务 {input.service}</Text>
        <Text color={tone(consolePalette.muted)}>级别 {input.level}</Text>
        <Text color={tone(consolePalette.muted)}>搜索 {input.search || '无'}</Text>
        <Text color={tone(consolePalette.muted)}>换行 {input.wrap ? '开' : '关'}</Text>
      </Box>
      <LogLines entries={visible} wrap={input.wrap} />
    </Box>
  )
}

function LogLines({ entries, wrap }: { entries: OperationsLogEntry[]; wrap: boolean }) {
  if (!entries.length) return <Text color={tone(consolePalette.muted)}>暂无符合筛选条件的日志。</Text>
  return <>{entries.map(entry => (
    <Text key={entry.sequence} wrap={wrap ? 'wrap' : 'truncate-end'} color={tone(logColor(entry.level))}>
      {shortTime(entry.createdAt)} [{entry.serviceId ?? '监督'}] {entry.stream === 'stderr' ? '!' : '·'} {entry.message}
    </Text>
  ))}</>
}

function AccountsView(input: { accounts: LocalManagedAccount[]; selectedIndex: number; error: string | null }) {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
      <Text bold color={tone(consolePalette.focus)}>Better Auth 账户 + GeoForge RBAC 投影</Text>
      {input.error && <Text color={tone(consolePalette.danger)}>✕ {input.error}</Text>}
      <Box><Cell width={30} muted>邮箱</Cell><Cell width={18} muted>名称</Cell><Cell width={16} muted>认证状态</Cell><Cell width={20} muted>平台状态</Cell><Cell muted>平台角色</Cell></Box>
      {input.accounts.map((account, index) => (
        <Box key={account.authUserId} backgroundColor={tone(index === input.selectedIndex ? consolePalette.selected : consolePalette.canvas)}>
          <Cell width={30} bold={index === input.selectedIndex}>{account.email}</Cell>
          <Cell width={18}>{account.displayName}</Cell>
          <Cell width={16} color={account.banned ? consolePalette.danger : consolePalette.healthy}>{account.banned ? '✕ 已禁用' : '● 正常'}</Cell>
          <Cell width={20}>{account.platformStatus ?? '未投影'}</Cell>
          <Cell>{formatAccountRoles(account)}</Cell>
        </Box>
      ))}
      {!input.accounts.length && !input.error && <Text color={tone(consolePalette.muted)}>当前没有公开认证账户；Console 服务主体不会出现在此列表。</Text>}
    </Box>
  )
}

function AuditView(input: { audits: AuditEvent[]; selectedIndex: number; error: string | null }) {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
      <Text bold color={tone(consolePalette.focus)}>本机运维与平台审计</Text>
      {input.error && <Text color={tone(consolePalette.danger)}>✕ {input.error}</Text>}
      <Box><Cell width={20} muted>时间</Cell><Cell width={38} muted>动作</Cell><Cell width={12} muted>结果</Cell><Cell muted>对象</Cell></Box>
      {input.audits.slice(0, 24).map((event, index) => (
        <Box key={event.auditEventId} backgroundColor={tone(index === input.selectedIndex ? consolePalette.selected : consolePalette.canvas)}>
          <Cell width={20}>{shortDate(event.createdAt)}</Cell>
          <Cell width={38} bold={index === input.selectedIndex}>{event.action}</Cell>
          <Cell width={12} color={event.outcome === 'allowed' ? consolePalette.healthy : event.outcome === 'denied' ? consolePalette.warning : consolePalette.danger}>{event.outcome}</Cell>
          <Cell>{event.objectType} {event.objectId ?? ''}</Cell>
        </Box>
      ))}
      {!input.audits.length && !input.error && <Text color={tone(consolePalette.muted)}>暂无审计事件。</Text>}
    </Box>
  )
}

function DialogView(input: {
  dialog: ConsoleDialog
  minPasswordLength: number
  onCancel: () => void
  onSearch: (value: string) => void
  onCreateSubmit: (value: string) => void
  onPasswordSubmit: (value: string) => void
}) {
  useInput((value, key) => {
    if (key.escape || (key.ctrl && value === 'c')) input.onCancel()
  })
  const dialog = input.dialog
  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      <Box width={72} minHeight={10} flexDirection="column" borderStyle="double" borderColor={tone(consolePalette.focus)} paddingX={2} paddingY={1} backgroundColor={tone(consolePalette.panelRaised)}>
        {dialog.kind === 'help' && <HelpContent />}
        {dialog.kind === 'search' && <>
          <Text bold color={tone(consolePalette.focus)}>日志搜索</Text>
          <Text color={tone(consolePalette.muted)}>输入关键字；支持中文与粘贴。空值清除筛选。</Text>
          <PasteTextInput placeholder="关键字" onSubmit={input.onSearch} />
        </>}
        {dialog.kind === 'confirm' && <>
          <Text bold color={tone(dialog.expected ? consolePalette.danger : consolePalette.warning)}>{dialog.title}</Text>
          <Text>{dialog.detail}</Text>
          {dialog.expected
            ? <>
                <Text color={tone(consolePalette.muted)}>请输入“{dialog.expected}”确认：</Text>
                <PasteTextInput onSubmit={value => {
                  if (value.trim() === dialog.expected) void dialog.execute()
                  else input.onCancel()
                }} />
              </>
            : <ConfirmInput defaultChoice="cancel" onConfirm={() => void dialog.execute()} onCancel={input.onCancel} />}
        </>}
        {dialog.kind === 'create' && <>
          <Text bold color={tone(consolePalette.focus)}>创建平台管理员 · 本机根权限</Text>
          <Text color={tone(consolePalette.muted)}>步骤 {createStepNumber(dialog.step)}/5 · 认证写入使用 Better Auth Admin API。</Text>
          {dialog.step === 'email' && <PasteTextInput key="create-email" placeholder="邮箱" onSubmit={input.onCreateSubmit} />}
          {dialog.step === 'name' && <PasteTextInput key="create-name" placeholder="显示名称" onSubmit={input.onCreateSubmit} />}
          {dialog.step === 'password' && <><Text>密码至少 {input.minPasswordLength} 个字符：</Text><PasswordInput onSubmit={input.onCreateSubmit} /></>}
          {dialog.step === 'repeat' && <><Text>再次输入密码：</Text><PasswordInput onSubmit={input.onCreateSubmit} /></>}
          {dialog.step === 'confirm' && <><Text color={tone(consolePalette.danger)}>输入目标邮箱“{dialog.email}”确认创建：</Text><PasteTextInput key="create-confirm" onSubmit={input.onCreateSubmit} /></>}
        </>}
        {dialog.kind === 'password' && <>
          <Text bold color={tone(consolePalette.danger)}>重置密码并撤销全部会话</Text>
          <Text color={tone(consolePalette.muted)}>目标：{dialog.targetEmail} · 步骤 {dialog.step === 'password' ? 1 : dialog.step === 'repeat' ? 2 : 3}/3</Text>
          {dialog.step === 'password' && <><Text>新密码至少 {input.minPasswordLength} 个字符：</Text><PasswordInput onSubmit={input.onPasswordSubmit} /></>}
          {dialog.step === 'repeat' && <><Text>再次输入新密码：</Text><PasswordInput onSubmit={input.onPasswordSubmit} /></>}
          {dialog.step === 'confirm' && <><Text>输入目标邮箱确认：</Text><PasteTextInput key="password-confirm" onSubmit={input.onPasswordSubmit} /></>}
        </>}
        <Text color={tone(consolePalette.muted)}>Esc 取消</Text>
      </Box>
    </Box>
  )
}

function PasteTextInput(input: { placeholder?: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('')
  const [revision, setRevision] = useState(0)
  usePaste(text => {
    setValue(current => `${current}${text.replace(/[\r\n]+/gu, ' ')}`.slice(0, 500))
    setRevision(current => current + 1)
  })
  return <TextInput
    key={revision}
    defaultValue={value}
    {...(input.placeholder === undefined ? {} : { placeholder: input.placeholder })}
    onChange={setValue}
    onSubmit={input.onSubmit}
  />
}

function HelpContent() {
  return <>
    <Text bold color={tone(consolePalette.focus)}>快捷键</Text>
    <Text>1–4 切换页面 · ↑↓ 选择 · Enter 检查器</Text>
    <Text>S 启动 · X 停止 · R 重启 · / 搜索日志</Text>
    <Text>F 暂停/跟随 · W 换行 · L 级别 · [ ] 服务</Text>
    <Text>账户：N 新建 · G 授权 · X 撤权 · E 启停 · P 密码 · V 会话</Text>
    <Text color={tone(consolePalette.healthy)}>q / Ctrl+C：仅分离，服务继续运行</Text>
    <Text color={tone(consolePalette.danger)}>Q：输入“停止全部”后停止服务并关闭监督器</Text>
  </>
}

function SizeWarning({ columns, rows, onExit }: { columns: number; rows: number; onExit: () => void }) {
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onExit()
  })
  return (
    <Box width={Math.max(1, columns)} height={Math.max(1, rows)} justifyContent="center" alignItems="center" flexDirection="column">
      <Text bold color={tone(consolePalette.warning)}>终端尺寸不足，界面已安全暂停渲染。</Text>
      <Text>当前 {columns}×{rows}，至少需要 80×24。</Text>
      <Text color={tone(consolePalette.muted)}>请放大窗口；q / Ctrl+C 仅分离。</Text>
    </Box>
  )
}

function ConsoleFooter({ tab, feedback }: { tab: LocalConsoleTab; feedback: string }) {
  const keys = tab === 'services'
    ? '↑↓ 选择  Enter 检查器  S 启动  X 停止  R 重启  / 搜索'
    : tab === 'logs'
      ? 'F 暂停/跟随  W 换行  L 级别  [ ] 服务  / 搜索'
      : tab === 'accounts'
        ? '↑↓ 选择  N 新建  G 授权  X 撤权  E 启停  P 密码  V 会话  U 刷新'
        : '↑↓ 选择  U 刷新'
  return (
    <Box borderStyle="single" borderColor={tone(consolePalette.border)} paddingX={1} justifyContent="space-between">
      <Text color={tone(consolePalette.text)}>{keys}</Text>
      <Text color={tone(consolePalette.muted)}>{feedback} · q 分离</Text>
    </Box>
  )
}

function Cell(input: { width?: number; children: React.ReactNode; muted?: boolean; bold?: boolean; color?: string }) {
  return <Box width={input.width} flexShrink={input.width ? 0 : 1} paddingRight={1}>
    <Text wrap="truncate-end" bold={Boolean(input.bold)} color={tone(input.color ?? (input.muted ? consolePalette.muted : consolePalette.text))}>{input.children}</Text>
  </Box>
}

function servicePresentation(service: OperationsServiceSnapshot): { symbol: string; label: string; color: string } {
  const map: Record<OperationsServiceSnapshot['state'], { symbol: string; label: string; color: string }> = {
    stopped: { symbol: '○', label: '已停止', color: consolePalette.muted },
    waiting_dependency: { symbol: '◌', label: '等待依赖', color: consolePalette.warning },
    starting: { symbol: '◐', label: '启动中', color: consolePalette.focus },
    healthy: { symbol: '●', label: '健康', color: consolePalette.healthy },
    degraded: { symbol: '▲', label: '降级', color: consolePalette.warning },
    stopping: { symbol: '◑', label: '停止中', color: consolePalette.warning },
    restart_wait: { symbol: '↻', label: '等待重启', color: consolePalette.warning },
    failed: { symbol: '✕', label: '失败', color: consolePalette.danger },
    conflict: { symbol: '◆', label: '冲突', color: consolePalette.danger },
  }
  return map[service.state]
}

function serviceImpact(service: OperationsServiceSnapshot, snapshot: OperationsSnapshot | null): string {
  if (service.serviceId === 'infra') return '基础设施停止会中断数据库、地图瓦片和所有上层服务。'
  const blocked = snapshot?.services.filter(item => item.blockedBy.includes(service.serviceId)).map(item => item.displayName) ?? []
  return blocked.length ? `依赖影响：${blocked.join('、')} 将进入降级或停止。` : '操作只针对当前服务及其运行中的依赖方。'
}

function assertOperationSucceeded(result: OperationsOperationResult): void {
  if (result.outcome === 'failed') throw new Error(result.message)
}

function operationFeedback(result: OperationsOperationResult): string {
  return `${result.outcome === 'succeeded' ? '✓' : result.outcome === 'partial' ? '▲' : '✕'} ${result.message} · ${result.operationId.slice(0, 8)}`
}

function cycleService(current: OperationsServiceId | 'all', direction: number): OperationsServiceId | 'all' {
  const values: Array<OperationsServiceId | 'all'> = ['all', ...ALL_SERVICES]
  const index = values.indexOf(current)
  return values[(index + direction + values.length) % values.length] ?? 'all'
}

function formatAccountRoles(account: LocalManagedAccount): string {
  const roles = [...new Set(account.platformRoles.map(binding => binding.role))]
  return roles.length ? roles.join(', ') : '无'
}

function logColor(level: OperationsLogEntry['level']): string {
  if (level === 'error') return consolePalette.danger
  if (level === 'warn') return consolePalette.warning
  if (level === 'debug') return consolePalette.muted
  if (level === 'info') return consolePalette.text
  return consolePalette.muted
}

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? '未知' : `${value.toFixed(1)}${suffix}`
}

function formatBytes(value: number | null): string {
  if (value === null) return '未知'
  if (value < 1024) return `${value.toFixed(0)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

function formatPercent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return '未知'
  return `${((used / total) * 100).toFixed(1)}%`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function shortTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false })
}

function shortDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }).slice(0, 19)
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)))
}

function createStepNumber(step: Extract<ConsoleDialog, { kind: 'create' }>['step']): number {
  return { email: 1, name: 2, password: 3, repeat: 4, confirm: 5 }[step]
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500) : '未知错误。'
}

function tone(color: string): string {
  return color
}
