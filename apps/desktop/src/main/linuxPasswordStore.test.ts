// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux 系统安全存储选择测试
//
//   文件:       linuxPasswordStore.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { configureLinuxPasswordStore } from './linuxPasswordStore.js'

describe('configureLinuxPasswordStore', () => {
  it('selects KWallet 6 for a Plasma 6 session before Electron becomes ready', () => {
    const appendSwitch = vi.fn()

    expect(configureLinuxPasswordStore({
      platform: 'linux',
      environment: {
        XDG_CURRENT_DESKTOP: 'KDE',
        XDG_SESSION_DESKTOP: 'KDE',
        KDE_FULL_SESSION: 'true',
      },
      appendSwitch,
    })).toBe('kwallet6')
    expect(appendSwitch).toHaveBeenCalledWith('password-store', 'kwallet6')
  })

  it('preserves KWallet 5 for an explicitly identified Plasma 5 session', () => {
    const appendSwitch = vi.fn()

    expect(configureLinuxPasswordStore({
      platform: 'linux',
      environment: {
        DESKTOP_SESSION: 'plasma',
        KDE_SESSION_VERSION: '5',
      },
      appendSwitch,
    })).toBe('kwallet5')
    expect(appendSwitch).toHaveBeenCalledWith('password-store', 'kwallet5')
  })

  it('does not override the password store outside KDE on Linux', () => {
    const appendSwitch = vi.fn()

    expect(configureLinuxPasswordStore({
      platform: 'linux',
      environment: { XDG_CURRENT_DESKTOP: 'GNOME' },
      appendSwitch,
    })).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
