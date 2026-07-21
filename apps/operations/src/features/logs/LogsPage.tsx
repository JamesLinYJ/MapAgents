// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 实时服务日志
//
//   文件:       LogsPage.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Download, Pause, Play, Search, Trash2, WrapText } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { OpsLogEntry, OpsLogLevel, OpsServiceId } from '@geo-agent-platform/shared-types/operations'
import { useEffect, useRef, useState } from 'react'

import { opsControlClient } from '../../api/controlClient'
import { StatusPill } from '../../components/StatusPill'

const SERVICES: OpsServiceId[] = ['web', 'api', 'worker', 'infra']
const LEVELS: OpsLogLevel[] = ['info', 'warn', 'error', 'fatal', 'debug', 'trace']

export function LogsPage({ logs, onClear }: { logs: OpsLogEntry[]; onClear(): void }) {
  const [services, setServices] = useState<OpsServiceId[]>([...SERVICES])
  const [levels, setLevels] = useState<OpsLogLevel[]>([])
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)
  const [wrap, setWrap] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)
  const pausedLogsRef = useRef<OpsLogEntry[]>([])
  const visibleLogs = paused ? pausedLogsRef.current : logs
  const virtualizer = useVirtualizer({
    count: visibleLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => wrap ? 40 : 27,
    overscan: 16,
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      if (services.length) void opsControlClient.subscribeLogs({ services, levels, search, tail: 500 })
    }, 250)
    return () => clearTimeout(timer)
  }, [services, levels, search])
  useEffect(() => {
    if (!paused && visibleLogs.length) virtualizer.scrollToIndex(visibleLogs.length - 1, { align: 'end' })
  }, [paused, visibleLogs.length, virtualizer])

  const exportQuery = new URLSearchParams({
    services: services.join(','),
    levels: levels.join(','),
    search,
    tail: '5000',
  })
  const togglePaused = () => {
    if (!paused) pausedLogsRef.current = [...logs]
    setPaused(value => !value)
  }
  const clear = () => {
    pausedLogsRef.current = []
    onClear()
  }
  return <div className="ops-page ops-page--fill">
    <header className="ops-page__heading">
      <div><p>流式输出</p><h1>实时日志</h1></div>
      <span className="ops-muted">最多保留最近 10,000 行，导出限 5,000 行</span>
    </header>
    <div className="ops-log-toolbar">
      <div className="ops-segmented">
        {SERVICES.map(service => <button key={service} className={services.includes(service) ? 'is-active' : ''} onClick={() => setServices(current => current.includes(service) ? current.filter(item => item !== service) : [...current, service])}>{service}</button>)}
      </div>
      <div className="ops-segmented ops-segmented--levels">
        {LEVELS.slice(0, 4).map(level => <button key={level} className={levels.includes(level) ? 'is-active' : ''} onClick={() => setLevels(current => current.includes(level) ? current.filter(item => item !== level) : [...current, level])}>{level}</button>)}
      </div>
      <label className="ops-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索日志" /></label>
      <button className="ops-icon-button" title={paused ? '继续跟随' : '暂停'} onClick={togglePaused}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
      <button className={`ops-icon-button ${wrap ? 'is-active' : ''}`} title="自动换行" onClick={() => setWrap(value => !value)}><WrapText size={14} /></button>
      <button className="ops-icon-button" title="清空当前视图" onClick={clear}><Trash2 size={14} /></button>
      <a className="ops-icon-button" title="导出受限日志" href={`/ops/api/v1/logs/export?${exportQuery}`}><Download size={14} /></a>
    </div>
    <div className={`ops-log-view ${wrap ? 'ops-log-view--wrap' : ''}`} ref={parentRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => {
          const entry = visibleLogs[item.index]
          if (!entry) return null
          return <div
            className="ops-log-row"
            key={`${entry.sequence}:${item.index}`}
            ref={virtualizer.measureElement}
            data-index={item.index}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <time>{new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            <span className="ops-log-row__service">{entry.serviceId}</span>
            <StatusPill value={entry.level} />
            <code>{entry.message}</code>
          </div>
        })}
      </div>
      {!visibleLogs.length && <div className="ops-empty">等待符合筛选条件的日志…</div>}
    </div>
  </div>
}
