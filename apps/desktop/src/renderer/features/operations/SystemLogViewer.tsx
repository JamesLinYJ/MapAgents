// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机系统日志查看器
//
//   文件:       SystemLogViewer.tsx
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  OperationsLogEntry,
  OperationsLogQuery,
} from '@geo-agent-platform/shared-types/operations'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Copy,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { requireDesktopBridge } from '../../api/transport'
import { Dialog } from '../../shared/components/GlassDialog'

const SERVICE_OPTIONS = [
  { value: 'all', label: '全部服务' },
  { value: 'infra', label: '原生基础设施' },
  { value: 'worker', label: '科学计算 Worker' },
  { value: 'api', label: '平台 API' },
] as const

const LEVEL_OPTIONS: ReadonlyArray<{ value: 'all' | OperationsLogLevel; label: string }> = [
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误' },
  { value: 'warn', label: '警告' },
  { value: 'info', label: '信息' },
  { value: 'debug', label: '调试' },
  { value: 'unknown', label: '未分类' },
]

type ServiceFilter = typeof SERVICE_OPTIONS[number]['value']
type OperationsLogLevel = OperationsLogEntry['level']
type StreamFilter = 'all' | OperationsLogEntry['stream']

export function SystemLogViewer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [entries, setEntries] = useState<OperationsLogEntry[]>([])
  const [service, setService] = useState<ServiceFilter>('all')
  const [level, setLevel] = useState<'all' | OperationsLogLevel>('all')
  const [stream, setStream] = useState<StreamFilter>('all')
  const [search, setSearch] = useState('')
  const [includeSupervisor, setIncludeSupervisor] = useState(true)
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const inFlight = useRef(false)
  const scrollElement = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const previouslyFocusedElement = useRef<HTMLElement | null>(null)
  const deferredSearch = useDeferredValue(search)

  const query = useMemo<OperationsLogQuery>(() => ({
    services: service === 'all' ? ['infra', 'worker', 'api'] : [service],
    levels: level === 'all' ? [] : [level],
    streams: stream === 'all' ? [] : [stream],
    search: deferredSearch.trim(),
    includeSupervisor,
    afterSequence: null,
    tail: 2_000,
  }), [deferredSearch, includeSupervisor, level, service, stream])

  const refresh = useCallback(async () => {
    if (!open || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const next = await requireDesktopBridge().supervisor.logs(query)
      setEntries(next)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [open, query])

  useEffect(() => {
    if (!open) return
    void refresh()
    if (paused) return
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => window.clearInterval(timer)
  }, [open, paused, refresh])

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => 31,
    overscan: 24,
  })

  useEffect(() => {
    if (!open || paused || entries.length === 0) return
    rowVirtualizer.scrollToIndex(entries.length - 1, { align: 'end' })
  }, [entries.length, open, paused, rowVirtualizer])

  if (!open) return null

  const copyVisibleLogs = async () => {
    try {
      const text = entries.map(formatLogLine).join('\n')
      await requireDesktopBridge().clipboard.writeText(text)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={nextOpen => {
      if (!nextOpen) onClose()
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="gf-system-logs" />
        <Dialog.Content
          className="gf-system-logs__panel"
          onOpenAutoFocus={event => {
            previouslyFocusedElement.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
            event.preventDefault()
            searchInput.current?.focus()
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            previouslyFocusedElement.current?.focus()
            previouslyFocusedElement.current = null
          }}
        >
        <header className="gf-system-logs__header">
          <div>
            <Dialog.Description asChild>
              <small>Desktop Main 与 Supervisor 本机事实流</small>
            </Dialog.Description>
            <Dialog.Title asChild>
              <h2>系统日志</h2>
            </Dialog.Title>
          </div>
          <div className="gf-system-logs__actions">
            <button type="button" title="复制当前结果" onClick={() => void copyVisibleLogs()}>
              <Copy size={14} aria-hidden="true" />
              复制
            </button>
            <button type="button" title={paused ? '继续跟随' : '暂停跟随'} onClick={() => setPaused(value => !value)}>
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              {paused ? '继续' : '暂停'}
            </button>
            <button type="button" title="立即刷新" onClick={() => void refresh()}>
              <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} aria-hidden="true" />
              刷新
            </button>
            <Dialog.Close asChild>
              <button className="gf-system-logs__close" type="button" aria-label="关闭系统日志">
                <X size={16} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
        </header>

        <div className="gf-system-logs__filters">
          <label>
            <span>服务</span>
            <select value={service} onChange={event => setService(event.currentTarget.value as ServiceFilter)}>
              {SERVICE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>级别</span>
            <select value={level} onChange={event => setLevel(event.currentTarget.value as 'all' | OperationsLogLevel)}>
              {LEVEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>输出流</span>
            <select value={stream} onChange={event => setStream(event.currentTarget.value as StreamFilter)}>
              <option value="all">全部输出</option>
              <option value="stdout">标准输出</option>
              <option value="stderr">标准错误</option>
              <option value="supervisor">监督事件</option>
            </select>
          </label>
          <label className="gf-system-logs__search">
            <span>搜索</span>
            <span>
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchInput}
                name="system-log-search"
                value={search}
                onChange={event => setSearch(event.currentTarget.value)}
                autoComplete="off"
                placeholder="服务、组件或正文…"
              />
            </span>
          </label>
          <label className="gf-system-logs__check">
            <input
              type="checkbox"
              checked={includeSupervisor}
              onChange={event => setIncludeSupervisor(event.currentTarget.checked)}
            />
            Supervisor
          </label>
        </div>

        <div className="gf-system-logs__summary">
          <span>{entries.length} 条 · 最多显示最近 2,000 条</span>
          <span>{paused ? '已暂停跟随' : '每 1.5 秒刷新'}</span>
          {errorMessage ? <strong role="alert">{errorMessage}</strong> : null}
        </div>

        <div className="gf-system-logs__table-head" aria-hidden="true">
          <span>时间</span>
          <span>级别</span>
          <span>服务 / 组件 / PID</span>
          <span>消息</span>
        </div>
        <div className="gf-system-logs__viewport" ref={scrollElement}>
          {entries.length === 0 && !loading ? (
            <div className="gf-system-logs__empty">当前筛选条件下没有日志。</div>
          ) : (
            <div className="gf-system-logs__virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              {rowVirtualizer.getVirtualItems().map(virtualRow => {
                const entry = entries[virtualRow.index]
                if (!entry) return null
                return (
                  <LogRow
                    key={`${entry.serviceId ?? entry.component ?? 'system'}-${entry.sequence}`}
                    entry={entry}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  />
                )
              })}
            </div>
          )}
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LogRow({
  entry,
  style,
}: {
  entry: OperationsLogEntry
  style: { transform: string }
}) {
  const source = [
    entry.serviceId ?? 'supervisor',
    entry.component,
    entry.processId ? `PID ${entry.processId}` : null,
  ].filter(Boolean).join(' / ')
  return (
    <div className="gf-system-log-row" data-level={entry.level} style={style}>
      <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
      <span className="gf-system-log-row__level">{levelLabel(entry.level)}</span>
      <span className="gf-system-log-row__source" title={source}>{source}</span>
      <span className="gf-system-log-row__message" title={entry.message}>{entry.message}</span>
    </div>
  )
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function levelLabel(level: OperationsLogLevel): string {
  return ({
    debug: '调试',
    info: '信息',
    warn: '警告',
    error: '错误',
    unknown: '普通',
  })[level]
}

function formatLogLine(entry: OperationsLogEntry): string {
  const source = [entry.serviceId ?? 'supervisor', entry.component, entry.processId].filter(Boolean).join('/')
  return `${entry.createdAt} [${entry.level}] [${source}] [${entry.stream}] ${entry.message}`
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '读取系统日志失败。'
}
