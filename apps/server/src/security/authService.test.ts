// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 认证服务测试
//
//   文件:       authService.test.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { Database } from '../db/connection.js'
import { parseEnv } from '../framework/env.js'
import { BetterAuthService } from './authService.js'
import type { PlatformIdentityService } from './platformIdentityService.js'

describe('BetterAuthService local admin boundary', () => {
  it('does not expose Admin Plugin management endpoints over HTTP', async () => {
    const service = new BetterAuthService({
      db: {} as Database,
      env: parseEnv({
        API_PORT: '8000',
        API_HOST: '127.0.0.1',
        DATABASE_URL: 'postgresql://example.invalid/test',
        RUNTIME_ROOT: './runtime',
        APP_BASE_URL: 'http://127.0.0.1:8000',
        BETTER_AUTH_URL: 'http://127.0.0.1:8000',
        BETTER_AUTH_SECRET: 'test-only-better-auth-secret-change-before-production',
        ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
      }),
      identity: {} as PlatformIdentityService,
    })

    const response = await service.handler(new Request('http://127.0.0.1:8000/api/auth/admin/list-users'))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      detail: '该认证管理接口仅允许通过服务器本地 Console 使用。',
    })
  })

  it('rejects Console-reserved identities at the public email authentication boundary', async () => {
    const service = createService()
    const response = await service.handler(new Request('http://127.0.0.1:8000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'console-test@console.geo-agent-platform.invalid',
        password: 'not-the-real-secret',
      }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      detail: '该保留身份不能通过公共认证入口使用。',
    })
  })

  it('rejects Local Agent identities at the public email authentication boundary', async () => {
    const service = createService()
    const response = await service.handler(new Request('http://127.0.0.1:8000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'agent@local-agent.geo-agent-platform.invalid',
        password: 'not-the-real-secret',
      }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      detail: '该保留身份不能通过公共认证入口使用。',
    })
  })

  it('trusts the exact Better Auth Electron scheme without weakening origin checks', () => {
    const service = createService()

    expect(service.isTrustedOrigin('com.geo-agent-platform.desktop:/')).toBe(true)
    expect(service.isTrustedOrigin('com.geo-agent-platform.desktop.evil:/')).toBe(false)
    expect(service.isTrustedOrigin('https://com.geo-agent-platform.desktop')).toBe(false)
  })
})

function createService(): BetterAuthService {
  return new BetterAuthService({
    db: {} as Database,
    env: parseEnv({
      API_PORT: '8000',
      API_HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://example.invalid/test',
      RUNTIME_ROOT: './runtime',
      APP_BASE_URL: 'http://127.0.0.1:8000',
      BETTER_AUTH_URL: 'http://127.0.0.1:8000',
      BETTER_AUTH_SECRET: 'test-only-better-auth-secret-change-before-production',
      ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
    }),
    identity: {} as PlatformIdentityService,
  })
}
