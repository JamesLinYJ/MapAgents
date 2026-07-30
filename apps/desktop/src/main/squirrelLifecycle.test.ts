// +-------------------------------------------------------------------------
//
//   地理智能平台 - Windows Squirrel 安装生命周期测试
//
//   文件:       squirrelLifecycle.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { handleSquirrelLifecycle } from './squirrelLifecycle.js'

describe('handleSquirrelLifecycle', () => {
  it.each([
    ['--squirrel-install', '--createShortcut'],
    ['--squirrel-updated', '--createShortcut'],
    ['--squirrel-uninstall', '--removeShortcut'],
  ] as const)('handles %s before normal application startup', (event, expectedVerb) => {
    const quit = vi.fn()
    const runUpdate = vi.fn()

    expect(handleSquirrelLifecycle({
      platform: 'win32',
      arguments: ['C:\\Users\\operator\\AppData\\Local\\GeoForge\\app-0.1.0\\GeoForge.exe', event],
      executablePath: 'C:\\Users\\operator\\AppData\\Local\\GeoForge\\app-0.1.0\\GeoForge.exe',
      quit,
      runUpdate,
    })).toBe(true)

    expect(runUpdate).toHaveBeenCalledWith(
      'C:\\Users\\operator\\AppData\\Local\\GeoForge\\Update.exe',
      [expectedVerb, 'GeoForge.exe'],
      quit,
    )
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits obsolete versions without invoking Update.exe', () => {
    const quit = vi.fn()
    const runUpdate = vi.fn()

    expect(handleSquirrelLifecycle({
      platform: 'win32',
      arguments: ['GeoForge.exe', '--squirrel-obsolete'],
      executablePath: 'C:\\GeoForge\\app-0.1.0\\GeoForge.exe',
      quit,
      runUpdate,
    })).toBe(true)
    expect(quit).toHaveBeenCalledOnce()
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('leaves normal launches and non-Windows platforms untouched', () => {
    const quit = vi.fn()
    const runUpdate = vi.fn()
    const normal = {
      arguments: ['GeoForge.exe', '--squirrel-firstrun'],
      executablePath: 'C:\\GeoForge\\app-0.1.0\\GeoForge.exe',
      quit,
      runUpdate,
    }

    expect(handleSquirrelLifecycle({ ...normal, platform: 'win32' })).toBe(false)
    expect(handleSquirrelLifecycle({
      ...normal,
      platform: 'linux',
      arguments: ['geoforge', '--squirrel-install'],
    })).toBe(false)
    expect(quit).not.toHaveBeenCalled()
    expect(runUpdate).not.toHaveBeenCalled()
  })
})
