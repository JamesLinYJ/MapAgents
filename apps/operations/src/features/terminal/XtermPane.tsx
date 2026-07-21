// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 交互式 xterm 终端面板
//
//   文件:       XtermPane.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { Clipboard, Copy, Search, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { OpsTerminalSession } from '@geo-agent-platform/shared-types/operations'

import { OpsTerminalConnection } from '../../api/terminalClient'

export function XtermPane({
  session,
  csrfToken,
  onState,
}: {
  session: OpsTerminalSession
  csrfToken: string
  onState(value: OpsTerminalSession): void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const connectionRef = useRef<OpsTerminalConnection | null>(null)
  const [connected, setConnected] = useState(false)
  const [message, setMessage] = useState<string | null>('正在连接…')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cols: session.cols,
      rows: session.rows,
      scrollback: 10_000,
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.22,
      fontFamily: '"Cascadia Mono", "Microsoft YaHei UI", "Noto Sans Mono CJK SC", monospace',
      theme: {
        background: '#101417',
        foreground: '#d8e0e4',
        cursor: '#78d2b5',
        selectionBackground: '#375b65aa',
        black: '#20272b',
        brightBlack: '#617078',
        red: '#eb7f77',
        green: '#72c69e',
        yellow: '#d9b56d',
        blue: '#77aee9',
        magenta: '#b99ae8',
        cyan: '#65c3c8',
        white: '#d8e0e4',
      },
    })
    const fit = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(searchAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fit
    searchAddonRef.current = searchAddon
    const connection = new OpsTerminalConnection(session.terminalId, csrfToken, {
      onOutput: data => terminal.write(data),
      onScreen: data => { terminal.reset(); terminal.write(data) },
      onState,
      onConnection: (value, detail) => { setConnected(value); setMessage(detail) },
    })
    connectionRef.current = connection
    const input = terminal.onData(data => {
      try { connection.sendInput(data) } catch (error) { setMessage(error instanceof Error ? error.message : '终端未连接。') }
    })
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true
      if (event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection())
        return false
      }
      if (event.key.toLowerCase() === 'v') {
        void navigator.clipboard.readText().then(text => connection.sendInput(text)).catch(() => undefined)
        return false
      }
      return true
    })
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        connection.resize(terminal.cols, terminal.rows)
      } catch {
        // 首次连接完成后 Broker 会收到下一次有效尺寸变化。
      }
    })
    observer.observe(host)
    connection.connect()
    requestAnimationFrame(() => { try { fit.fit() } catch { /* 容器尚未可见 */ } })
    return () => {
      observer.disconnect()
      input.dispose()
      connection.close()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      connectionRef.current = null
    }
  }, [csrfToken, session.terminalId])

  useEffect(() => {
    if (!connected) return
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const connection = connectionRef.current
      try {
        fitAddonRef.current?.fit()
        if (terminal && connection) connection.resize(terminal.cols, terminal.rows)
      } catch {
        // 连接可能在布局帧内再次断开，重连成功后会重新执行。
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [connected])

  const find = () => {
    if (search) searchAddonRef.current?.findNext(search, { caseSensitive: false, incremental: true })
  }

  const copy = () => {
    const selection = terminalRef.current?.getSelection()
    if (selection) void navigator.clipboard.writeText(selection)
  }
  const paste = () => {
    void navigator.clipboard.readText().then(text => connectionRef.current?.sendInput(text)).catch(() => undefined)
  }

  return <section className="ops-terminal-pane">
    <div className="ops-terminal-toolbar">
      <span className={`ops-status-dot ops-status-dot--${connected ? 'good' : 'warn'}`} />
      <span>{connected ? '已连接' : message ?? '已断开'}</span>
      <span className="ops-terminal-toolbar__spacer" />
      <label className="ops-terminal-search"><Search size={13} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索终端" onKeyDown={event => { if (event.key === 'Enter') find() }} /></label>
      <button className="ops-icon-button" title="复制选择内容" onClick={copy}><Copy size={14} /></button>
      <button className="ops-icon-button" title="粘贴" onClick={paste}><Clipboard size={14} /></button>
      <button className="ops-icon-button" title="发送 Ctrl+C" onClick={() => connectionRef.current?.sendInput('\x03')}><Send size={14} /></button>
    </div>
    <div className="ops-xterm" ref={hostRef} />
  </section>
}
