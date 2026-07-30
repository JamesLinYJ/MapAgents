// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 开发环境装配测试
//
//   文件:       electronViteEnvironment.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { applyDesktopMainEnvironment } from '../../electron.vite.config.js'

describe('applyDesktopMainEnvironment', () => {
  it('loads only desktop Main settings and never copies provider or server secrets', () => {
    const target: NodeJS.ProcessEnv = {}

    applyDesktopMainEnvironment({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      RUNTIME_ROOT: 'C:\\GeoForge\\runtime',
      DEEPSEEK_API_KEY: 'must-not-enter-desktop-build',
      BETTER_AUTH_SECRET: 'must-not-enter-desktop-build',
    }, target)

    expect(target).toMatchObject({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      RUNTIME_ROOT: 'C:\\GeoForge\\runtime',
    })
    expect(target.DEEPSEEK_API_KEY).toBeUndefined()
    expect(target.BETTER_AUTH_SECRET).toBeUndefined()
  })

  it('preserves explicit shell settings over repository dotenv values', () => {
    const target: NodeJS.ProcessEnv = {
      API_PORT: '18123',
    }

    applyDesktopMainEnvironment({
      API_PORT: '8000',
    }, target)

    expect(target.API_PORT).toBe('18123')
  })
})
