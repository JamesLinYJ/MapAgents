// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - asciicast 只读回放
//
//   文件:       ReplayPane.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { opsAsciicastEventSchema, type OpsAsciicastEvent } from '@geo-agent-platform/shared-types/operations'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

const headerSchema = z.object({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  timestamp: z.number(),
}).passthrough()

export function ReplayPane({ terminalId, grantId }: { terminalId: string; grantId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [events, setEvents] = useState<OpsAsciicastEvent[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      scrollback: 10_000,
      fontSize: 13,
      lineHeight: 1.22,
      fontFamily: '"Cascadia Mono", "Microsoft YaHei UI", monospace',
      theme: { background: '#101417', foreground: '#d8e0e4', cursor: '#101417' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    const observer = new ResizeObserver(() => { try { fit.fit() } catch { /* hidden container */ } })
    observer.observe(host)
    requestAnimationFrame(() => { try { fit.fit() } catch { /* hidden container */ } })
    return () => { observer.disconnect(); terminal.dispose(); terminalRef.current = null }
  }, [terminalId])

  useEffect(() => {
    setError(null)
    setPlaying(false)
    setIndex(0)
    const query = grantId ? `?grant=${encodeURIComponent(grantId)}` : ''
    void fetch(`/ops/api/v1/transcripts/${encodeURIComponent(terminalId)}/cast${query}`, {
      credentials: 'include',
      cache: 'no-store',
    }).then(async response => {
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: unknown } | null
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : '终端记录加载失败。')
      }
      const lines = (await response.text()).split('\n').filter(Boolean)
      const headerLine = lines.shift()
      if (!headerLine) throw new Error('终端记录缺少 asciicast v2 头。')
      const header = headerSchema.parse(JSON.parse(headerLine) as unknown)
      terminalRef.current?.resize(header.width, header.height)
      const parsed = lines.map(line => opsAsciicastEventSchema.parse(JSON.parse(line) as unknown))
      setEvents(parsed)
      setPlaying(parsed.length > 0)
    }).catch(caught => setError(caught instanceof Error ? caught.message : '终端记录加载失败。'))
  }, [grantId, terminalId])

  useEffect(() => {
    if (!playing || index >= events.length) {
      if (index >= events.length) setPlaying(false)
      return
    }
    const event = events[index]
    if (!event) return
    const previousTime = events[index - 1]?.[0] ?? 0
    const delay = Math.min(1_000, Math.max(0, (event[0] - previousTime) * 1_000 / speed))
    const timer = setTimeout(() => {
      applyEvent(terminalRef.current, event)
      setIndex(value => value + 1)
    }, delay)
    return () => clearTimeout(timer)
  }, [events, index, playing, speed])

  const seek = (nextIndex: number) => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.reset()
    for (const event of events.slice(0, nextIndex)) applyEvent(terminal, event)
    setIndex(nextIndex)
  }

  return <section className="ops-replay">
    <div className="ops-replay__toolbar">
      <button className="ops-icon-button" onClick={() => setPlaying(value => !value)} disabled={!events.length}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <button className="ops-icon-button" onClick={() => { setPlaying(false); seek(0) }}><RotateCcw size={14} /></button>
      <input type="range" min={0} max={events.length} value={index} onChange={event => { setPlaying(false); seek(Number(event.target.value)) }} />
      <span className="ops-mono">{formatTime(events[index - 1]?.[0] ?? 0)} / {formatTime(events.at(-1)?.[0] ?? 0)}</span>
      <select value={speed} onChange={event => setSpeed(Number(event.target.value))} aria-label="回放速度">
        <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
      </select>
    </div>
    {error && <div className="ops-banner ops-banner--bad">{error}</div>}
    <div className="ops-xterm ops-xterm--replay" ref={hostRef} />
  </section>
}

function applyEvent(terminal: Terminal | null, event: OpsAsciicastEvent): void {
  if (!terminal) return
  if (event[1] === 'o') {
    terminal.write(event[2])
    return
  }
  const match = /^(\d+)x(\d+)$/u.exec(event[2])
  if (match?.[1] && match[2]) terminal.resize(Number(match[1]), Number(match[2]))
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}
