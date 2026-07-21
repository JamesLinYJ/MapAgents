// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维入口可见性
//
//   文件:       operationsAccess.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuthMe } from '@geo-agent-platform/shared-types'

export function canOpenOperations(auth: Pick<AuthMe, 'platformRoles'>): boolean {
  return auth.platformRoles.includes('platform_admin')
}
