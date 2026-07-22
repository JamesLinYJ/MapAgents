// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本地运维台界面契约
//
//   文件:       localConsoleTypes.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'

import type { LocalAccountService } from './localAccountService.js'

export type LocalConsoleTab = 'services' | 'logs' | 'accounts' | 'audit'

export interface LocalConsoleDataPlane {
  accounts: Pick<LocalAccountService,
    | 'listAccounts'
    | 'createPlatformAdmin'
    | 'grantPlatformAdmin'
    | 'revokePlatformAdmin'
    | 'setAccountEnabled'
    | 'resetPassword'
    | 'revokeSessions'>
  listAuditEvents: (limit?: number) => Promise<AuditEvent[]>
  close: () => Promise<void>
}

export interface LocalConsoleOptions {
  connectSupervisor: () => Promise<OperationsClient>
  openDataPlane: () => Promise<LocalConsoleDataPlane>
  minPasswordLength: number
}
