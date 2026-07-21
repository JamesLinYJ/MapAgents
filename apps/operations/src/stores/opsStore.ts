// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维实时状态
//
//   文件:       opsStore.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  OpsBootstrap,
  OpsHostSnapshot,
  OpsLogEntry,
  OpsServiceSnapshot,
  OpsTerminalSession,
} from '@geo-agent-platform/shared-types/operations'
import { create } from 'zustand'

interface OpsState {
  bootstrap: OpsBootstrap | null
  host: OpsHostSnapshot | null
  services: OpsServiceSnapshot[]
  logs: OpsLogEntry[]
  terminals: OpsTerminalSession[]
  connected: boolean
  connectionMessage: string | null
  setBootstrap(value: OpsBootstrap): void
  setHost(value: OpsHostSnapshot): void
  setServices(value: OpsServiceSnapshot[]): void
  appendLog(value: OpsLogEntry): void
  clearLogs(): void
  setTerminals(value: OpsTerminalSession[]): void
  upsertTerminal(value: OpsTerminalSession): void
  setConnection(connected: boolean, message: string | null): void
}

export const useOpsStore = create<OpsState>(set => ({
  bootstrap: null,
  host: null,
  services: [],
  logs: [],
  terminals: [],
  connected: false,
  connectionMessage: null,
  setBootstrap: value => set({ bootstrap: value, host: value.host, services: value.services }),
  setHost: value => set({ host: value }),
  setServices: value => set({ services: value }),
  appendLog: value => set(state => ({ logs: [...state.logs.slice(-9_999), value] })),
  clearLogs: () => set({ logs: [] }),
  setTerminals: value => set({ terminals: value }),
  upsertTerminal: value => set(state => ({
    terminals: [value, ...state.terminals.filter(item => item.terminalId !== value.terminalId)],
  })),
  setConnection: (connected, connectionMessage) => set({ connected, connectionMessage }),
}))
