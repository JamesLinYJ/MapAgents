// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维实时状态测试
//
//   文件:       opsStore.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OpsLogEntry, OpsTerminalSession } from '@geo-agent-platform/shared-types/operations'
import { beforeEach, describe, expect, it } from 'vitest'

import { useOpsStore } from './opsStore.js'

const timestamp = '2026-07-21T00:00:00.000Z'

beforeEach(() => {
  useOpsStore.setState({
    bootstrap: null,
    host: null,
    services: [],
    logs: [],
    terminals: [],
    connected: false,
    connectionMessage: null,
  })
})

describe('运维实时状态', () => {
  it('将日志限制在最近 10,000 条，避免长时间订阅无界增长', () => {
    useOpsStore.setState({ logs: Array.from({ length: 10_000 }, (_, sequence) => logEntry(sequence)) })

    useOpsStore.getState().appendLog(logEntry(10_000))

    const logs = useOpsStore.getState().logs
    expect(logs).toHaveLength(10_000)
    expect(logs[0]?.sequence).toBe(1)
    expect(logs.at(-1)?.sequence).toBe(10_000)
  })

  it('按终端 ID 原位更新并把最新状态移到首位', () => {
    useOpsStore.getState().setTerminals([
      terminalSession('terminal-a', 'running'),
      terminalSession('terminal-b', 'detached'),
    ])

    useOpsStore.getState().upsertTerminal(terminalSession('terminal-b', 'exited'))

    expect(useOpsStore.getState().terminals.map(item => [item.terminalId, item.state])).toEqual([
      ['terminal-b', 'exited'],
      ['terminal-a', 'running'],
    ])
  })

  it('同时保存连接事实与面向管理员的状态说明', () => {
    useOpsStore.getState().setConnection(false, '正在重新连接')
    expect(useOpsStore.getState()).toMatchObject({
      connected: false,
      connectionMessage: '正在重新连接',
    })

    useOpsStore.getState().setConnection(true, null)
    expect(useOpsStore.getState()).toMatchObject({ connected: true, connectionMessage: null })
  })
})

function logEntry(sequence: number): OpsLogEntry {
  return {
    sequence,
    serviceId: 'api',
    level: 'info',
    message: `log-${sequence}`,
    timestamp,
  }
}

function terminalSession(terminalId: string, state: OpsTerminalSession['state']): OpsTerminalSession {
  return {
    terminalId,
    ownerUserId: 'user-1',
    ownerDisplayName: '运维管理员',
    label: terminalId,
    state,
    shell: 'pwsh',
    cols: 120,
    rows: 30,
    pid: state === 'exited' ? null : 100,
    exitCode: state === 'exited' ? 0 : null,
    recordedBytes: 0,
    createdAt: timestamp,
    startedAt: timestamp,
    detachedAt: state === 'detached' ? timestamp : null,
    expiresAt: '2026-07-21T08:00:00.000Z',
    endedAt: state === 'exited' ? timestamp : null,
  }
}
