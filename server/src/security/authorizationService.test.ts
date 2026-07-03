// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin 授权服务单元测试
//
//   文件:       authorizationService.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { actionMatch } from './authorizationService.js'

/**
 * 直接测试生产 actionMatch 函数的逻辑，
 * 确保 policy action 不被当成正则：`read|create` 不应匹配 `reader`。
 */
describe('Casbin actionMatch', () => {
  it('matches exact action in pipe-delimited policy', () => {
    expect(actionMatch('read', 'read|create')).toBe(true)
    expect(actionMatch('create', 'read|create')).toBe(true)
    expect(actionMatch('update', 'read|create')).toBe(false)
    expect(actionMatch('delete', 'read|create')).toBe(false)
  })

  it('matches wildcard policy', () => {
    expect(actionMatch('read', '*')).toBe(true)
    expect(actionMatch('admin', '*')).toBe(true)
    expect(actionMatch('execute', '*')).toBe(true)
  })

  it('rejects non-string inputs', () => {
    expect(actionMatch(null, 'read')).toBe(false)
    expect(actionMatch('read', null)).toBe(false)
    expect(actionMatch(123, 'read')).toBe(false)
    expect(actionMatch('read', 456)).toBe(false)
  })

  it('does not treat policy action as regex — read|create does not match reader', () => {
    expect(actionMatch('reader', 'read|create')).toBe(false)
    expect(actionMatch('creater', 'read|create')).toBe(false)
  })

  it('tolerates whitespace around pipe segments', () => {
    expect(actionMatch('read', 'read | create')).toBe(true)
    expect(actionMatch('create', ' read|create ')).toBe(true)
  })

  it('rejects superstring matches', () => {
    expect(actionMatch('read', 'reader')).toBe(false)
    expect(actionMatch('create', 'recreate')).toBe(false)
  })
})
