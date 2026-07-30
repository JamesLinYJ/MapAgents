// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 权限策略测试
//
//   文件:       desktopPermissionPolicy.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { installDesktopPermissionPolicy } from './desktopPermissionPolicy.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'

type PermissionCheckHandler = NonNullable<
  Parameters<Session['setPermissionCheckHandler']>[0]
>
type PermissionRequestHandler = NonNullable<
  Parameters<Session['setPermissionRequestHandler']>[0]
>

describe('desktop permission policy', () => {
  it('keeps checks read-only and consumes only a trusted main-frame audio request', () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const { check, request } = installPolicy(gate)
    const webContents = fakeWebContents(41, 'geoforge://app/workspace')
    gate.grant(webContents.id)

    expect(check(webContents, 'media', 'geoforge://app', {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: 'geoforge://app/workspace',
    })).toBe(false)
    expect(gate.hasActiveGrant(webContents.id)).toBe(true)

    const callback = vi.fn()
    request(webContents, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'geoforge://app/workspace',
      securityOrigin: 'geoforge://app',
      mediaTypes: ['audio'],
    })
    expect(callback).toHaveBeenCalledWith(true)
    expect(gate.hasActiveGrant(webContents.id)).toBe(false)

    const repeated = vi.fn()
    request(webContents, 'media', repeated, {
      isMainFrame: true,
      requestingUrl: 'geoforge://app/workspace',
      securityOrigin: 'geoforge://app',
      mediaTypes: ['audio'],
    })
    expect(repeated).toHaveBeenCalledWith(false)
  })

  it('rejects video, mixed media, subframes, unknown windows and untrusted origins', () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const { check, request } = installPolicy(gate)
    const webContents = fakeWebContents(51, 'geoforge://app/workspace')
    gate.grant(webContents.id)

    expect(check(webContents, 'media', 'geoforge://app', {
      isMainFrame: true,
      mediaType: 'video',
      requestingUrl: 'geoforge://app/workspace',
    })).toBe(false)
    expect(check(webContents, 'media', 'geoforge://app', {
      isMainFrame: false,
      mediaType: 'audio',
      requestingUrl: 'geoforge://app/frame',
    })).toBe(false)
    expect(check(webContents, 'media', 'https://evil.example', {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: 'https://evil.example/',
    })).toBe(false)
    expect(check(fakeWebContents(52, 'geoforge://app/workspace'), 'media', 'geoforge://app', {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: 'geoforge://app/workspace',
    })).toBe(false)

    for (const details of [
      {
        isMainFrame: true,
        requestingUrl: 'geoforge://app/workspace',
        securityOrigin: 'geoforge://app',
        mediaTypes: ['video'] as Array<'video' | 'audio'>,
      },
      {
        isMainFrame: true,
        requestingUrl: 'geoforge://app/workspace',
        securityOrigin: 'geoforge://app',
        mediaTypes: ['audio', 'video'] as Array<'video' | 'audio'>,
      },
      {
        isMainFrame: false,
        requestingUrl: 'geoforge://app/frame',
        securityOrigin: 'geoforge://app',
        mediaTypes: ['audio'] as Array<'video' | 'audio'>,
      },
      {
        isMainFrame: true,
        requestingUrl: 'https://evil.example/',
        securityOrigin: 'https://evil.example',
        mediaTypes: ['audio'] as Array<'video' | 'audio'>,
      },
    ]) {
      const callback = vi.fn()
      request(webContents, 'media', callback, details)
      expect(callback).toHaveBeenCalledWith(false)
    }
    expect(gate.hasActiveGrant(webContents.id)).toBe(true)
  })
})

function installPolicy(gate: MicrophonePermissionGate): {
  check: PermissionCheckHandler
  request: PermissionRequestHandler
} {
  let check: PermissionCheckHandler | null = null
  let request: PermissionRequestHandler | null = null
  const electronSession = {
    setPermissionCheckHandler(handler: PermissionCheckHandler | null) {
      check = handler
    },
    setPermissionRequestHandler(handler: PermissionRequestHandler | null) {
      request = handler
    },
  } as unknown as Session
  installDesktopPermissionPolicy(electronSession, gate)
  if (!check || !request) throw new Error('权限策略未安装。')
  return { check, request }
}

function fakeWebContents(id: number, url: string): WebContents {
  return {
    id,
    getURL: () => url,
  } as unknown as WebContents
}
