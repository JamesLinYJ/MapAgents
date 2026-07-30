// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 高风险文字确认窗口测试
//
//   文件:       typedConfirmationWindow.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
}))

import {
  confirmationDocumentUrl,
  parseConfirmationNavigation,
} from './typedConfirmationWindow.js'

describe('typed confirmation window contract', () => {
  it('accepts only the nonce-bound local submit or cancel navigation', () => {
    expect(parseConfirmationNavigation(
      'geoforge-confirm://submit/nonce_1?confirmation=%E5%81%9C%E6%AD%A2%E5%85%A8%E9%83%A8',
      'nonce_1',
    )).toEqual({ kind: 'submit', value: '停止全部' })
    expect(parseConfirmationNavigation(
      'geoforge-confirm://cancel/nonce_1',
      'nonce_1',
    )).toEqual({ kind: 'cancel', value: null })
    expect(parseConfirmationNavigation(
      'geoforge-confirm://submit/wrong?confirmation=%E5%81%9C%E6%AD%A2%E5%85%A8%E9%83%A8',
      'nonce_1',
    )).toBeNull()
    expect(parseConfirmationNavigation('https://example.com/', 'nonce_1')).toBeNull()
  })

  it('creates a script-free sandbox document that displays impact and requires exact text', () => {
    const url = confirmationDocumentUrl({
      title: '停止全部服务并退出 GeoForge',
      message: '会停止 API、Worker 与数据库。',
      detail: '普通退出不会停止后台服务。',
      expectedText: '停止全部',
    }, 'nonce_1')
    const document = decodeURIComponent(url.slice(url.indexOf(',') + 1))

    expect(document).toContain('会停止 API、Worker 与数据库。')
    expect(document).toContain('普通退出不会停止后台服务。')
    expect(document).toContain('pattern="停止全部"')
    expect(document).toContain('geoforge-confirm://submit/nonce_1')
    expect(document).not.toContain('<script')
  })
})
