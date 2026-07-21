// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维入口可见性测试
//
//   文件:       operationsAccess.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { canOpenOperations } from './operationsAccess'

describe('运维入口可见性', () => {
  it('只对 platform_admin 显示，不把工作区管理员提升为平台运维', () => {
    expect(canOpenOperations({ platformRoles: ['platform_admin'] })).toBe(true)
    expect(canOpenOperations({ platformRoles: ['workspace_admin'] })).toBe(false)
    expect(canOpenOperations({ platformRoles: ['analyst'] })).toBe(false)
    expect(canOpenOperations({ platformRoles: [] })).toBe(false)
  })
})
