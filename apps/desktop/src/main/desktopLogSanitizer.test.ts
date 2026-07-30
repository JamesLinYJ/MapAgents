// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志脱敏测试
//
//   文件:       desktopLogSanitizer.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  collectDesktopLogSecrets,
  sanitizeDesktopLogText,
  sanitizeDesktopLogValue,
} from './desktopLogSanitizer.js'

describe('desktop system log sanitization', () => {
  it('collects only secret-shaped environment values and redacts exact values', () => {
    const secrets = collectDesktopLogSecrets({
      API_PORT: '8000',
      OPENAI_API_KEY: 'provider-secret-value',
      BETTER_AUTH_SECRET: 'session-secret-value',
    })
    expect(secrets).toEqual(['provider-secret-value', 'session-secret-value'])
    expect(sanitizeDesktopLogText(
      'provider-secret-value session-secret-value',
      secrets,
    )).toBe('[REDACTED] [REDACTED]')
  })

  it('redacts credentials by field name, authorization scheme and URL userinfo', () => {
    const value = sanitizeDesktopLogValue({
      password: 'never-log-me',
      nested: {
        authorization: 'Bearer abcdefghijklmnop',
        endpoint: 'https://admin:secret@example.com/api',
      },
      error: new Error('access_token=abcdefghijklmnop'),
    }, [])

    expect(JSON.stringify(value)).not.toContain('never-log-me')
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnop')
    expect(JSON.stringify(value)).not.toContain('admin:secret')
    expect(value).toMatchObject({
      password: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        endpoint: 'https://[REDACTED]@example.com/api',
      },
    })
  })

  it('removes Windows and POSIX absolute paths before logs can reach Renderer', () => {
    const windows = '加载失败 at C:\\Users\\James\\Projects\\GeoForge\\main.ts:42:7'
    const unc = '记录位于 \\\\fileserver\\private\\desktop-main.log'
    const posix = '加载失败 at /home/james/geoforge/main.ts:42:7'
    const customMount = '加载失败 at /data/geoforge/main.ts:42:7'
    const fileUrl = '模块来自 file:///C:/Users/James/Projects/GeoForge/main.js'

    for (const value of [windows, unc, posix, customMount, fileUrl]) {
      const sanitized = sanitizeDesktopLogText(value, [])
      expect(sanitized).toContain('[LOCAL_PATH]')
      expect(sanitized).not.toMatch(/[A-Za-z]:[\\/]|\\\\fileserver|\/home\/james|\/data\/geoforge|file:\/\//u)
    }
    expect(sanitizeDesktopLogText('C:\\Program Files\\GeoForge\\desktop-main.log', []))
      .toBe('[LOCAL_PATH]')
    expect(sanitizeDesktopLogText('/Library/Application Support/GeoForge/desktop-main.log', []))
      .toBe('[LOCAL_PATH]')
  })

  it('preserves network URLs and fixed application routes while redacting unknown root paths', () => {
    expect(sanitizeDesktopLogText('GET /api/v1/layers?limit=20', []))
      .toBe('GET /api/v1/layers?limit=20')
    expect(sanitizeDesktopLogText('/health', [])).toBe('/health')
    expect(sanitizeDesktopLogText('https://api.example.com/v1/maps/style.json', []))
      .toBe('https://api.example.com/v1/maps/style.json')
    expect(sanitizeDesktopLogText('读取 /custom-volume/private/result.json 失败', []))
      .toBe('读取 [LOCAL_PATH] 失败')
  })
})
