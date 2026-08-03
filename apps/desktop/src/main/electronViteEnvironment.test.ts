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

import {
  applyDesktopMainEnvironment,
  resolveDesktopRendererServerOptions,
} from '../../electron.vite.config.js'

describe('applyDesktopMainEnvironment', () => {
  it('lets Vite choose an available development port when the default is occupied', () => {
    expect(resolveDesktopRendererServerOptions({})).toEqual({
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    })
  })

  it('keeps an explicitly configured Renderer port strict', () => {
    expect(resolveDesktopRendererServerOptions({
      DESKTOP_RENDERER_PORT: '55173',
    })).toEqual({
      host: '127.0.0.1',
      port: 55173,
      strictPort: true,
    })
  })

  it('loads only desktop Main settings and never copies provider or server secrets', () => {
    const target: NodeJS.ProcessEnv = {}

    applyDesktopMainEnvironment({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      RUNTIME_ROOT: 'C:\\PlatformFixture\\runtime',
      DEEPSEEK_API_KEY: 'must-not-enter-desktop-build',
      BETTER_AUTH_SECRET: 'must-not-enter-desktop-build',
    }, target)

    expect(target).toMatchObject({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      RUNTIME_ROOT: 'C:\\PlatformFixture\\runtime',
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
