// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 自动认证网关测试
//
//   文件:       authGateway.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

vi.mock('@better-auth/electron/client', () => ({ electronClient: vi.fn(() => ({})) }))
vi.mock('better-auth/client', () => ({ createAuthClient: vi.fn(() => ({})) }))
vi.mock('./secureAuthStorage.js', () => ({ SecureAuthStorage: class {} }))

import {
  desktopAuthBootstrapResultSchema,
  desktopAuthProjectionSchema,
} from '../contracts/desktopIpc.js'
import {
  DesktopAuthGateway,
  type DesktopAuthClientPort,
} from './authGateway.js'
import type { DesktopAutoAuthConfig } from './runtimeConfig.js'

describe('DesktopAuthGateway auto auth', () => {
  it('keeps interactive mode free of implicit account mutations', async () => {
    const client = fakeClient()
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', { client })

    const result = desktopAuthBootstrapResultSchema.parse(
      (await gateway.handle(request())).data,
    )

    expect(result).toEqual({ mode: 'interactive', status: 'ready', message: null })
    expect(client.getSession).not.toHaveBeenCalled()
    expect(client.signIn.email).not.toHaveBeenCalled()
    expect(client.signUp.email).not.toHaveBeenCalled()
  })

  it('reuses a matching Better Auth session without reading credentials', async () => {
    const client = fakeClient()
    vi.mocked(client.getSession).mockResolvedValue(ok(session('admin@example.com')))
    const readAutoAuthSecret = vi.fn<() => Promise<string>>()
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      autoAuth: autoAuth(),
      readAutoAuthSecret,
    })

    const result = desktopAuthBootstrapResultSchema.parse(
      (await gateway.handle(request())).data,
    )

    expect(result.status).toBe('authenticated')
    expect(readAutoAuthSecret).not.toHaveBeenCalled()
    expect(client.signIn.email).not.toHaveBeenCalled()
  })

  it('creates the configured local account through official email auth and never projects its password', async () => {
    const client = fakeClient()
    vi.mocked(client.getSession)
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(session('admin@example.com')))
    vi.mocked(client.signIn.email).mockResolvedValue(failed('INVALID_EMAIL_OR_PASSWORD'))
    vi.mocked(client.signUp.email).mockResolvedValue(ok({ user: { id: 'auth_1' } }))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      autoAuth: autoAuth(),
      readAutoAuthSecret: async () => 'local-secret-that-never-enters-renderer',
    })

    const response = await gateway.handle(request())
    const result = desktopAuthBootstrapResultSchema.parse(response.data)

    expect(result).toEqual({ mode: 'local_auto', status: 'authenticated', message: null })
    expect(client.signUp.email).toHaveBeenCalledWith({
      email: 'admin@example.com',
      name: 'GeoForge 演示管理员',
      password: 'local-secret-that-never-enters-renderer',
    })
    expect(JSON.stringify(response)).not.toContain('local-secret-that-never-enters-renderer')
  })

  it('reports a stable failure when account creation is disabled', async () => {
    const client = fakeClient()
    vi.mocked(client.getSession).mockResolvedValue(ok(null))
    vi.mocked(client.signIn.email).mockResolvedValue(failed('INVALID_EMAIL_OR_PASSWORD'))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      autoAuth: { ...autoAuth(), allowAccountCreation: false },
      readAutoAuthSecret: async () => 'another-private-secret',
    })

    const response = await gateway.handle(request())
    const result = desktopAuthBootstrapResultSchema.parse(response.data)

    expect(result.mode).toBe('local_auto')
    expect(result.status).toBe('failed')
    expect(result.message).toContain('关闭 Better Auth 注册')
    expect(client.signUp.email).not.toHaveBeenCalled()
    expect(JSON.stringify(response)).not.toContain('another-private-secret')
  })

  it('keeps CSRF and session cookies in Main while returning only the identity projection', async () => {
    const client = fakeClient()
    vi.mocked(client.getCookie).mockReturnValue('better-auth.session_token=main-only-cookie')
    let capturedInit: RequestInit | undefined
    const fetchApi = vi.fn(async (_url: string, init: RequestInit) => {
      capturedInit = init
      return jsonResponse(authMe('main-only-csrf'))
    })
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      fetchApi,
    })

    const response = await gateway.handle(authRequest('projection'))
    const projection = desktopAuthProjectionSchema.parse(response.data)

    expect(projection.user.email).toBe('admin@example.com')
    expect(projection.requestProtection).toBe('main_managed')
    expect(JSON.stringify(response)).not.toContain('main-only-csrf')
    expect(JSON.stringify(response)).not.toContain('main-only-cookie')
    expect(gateway.requireAuthorizationContext()).toMatchObject({
      userId: 'user_1',
      csrfToken: 'main-only-csrf',
      platformRoles: ['platform_admin'],
      permissions: ['workspace:read'],
    })
    const requestHeaders = new Headers(capturedInit?.headers)
    expect(requestHeaders.get('cookie')).toBe('better-auth.session_token=main-only-cookie')
  })

  it('does not return Better Auth sign-in data and refreshes the Main-owned authorization', async () => {
    const client = fakeClient()
    vi.mocked(client.signIn.email).mockResolvedValue(ok({
      token: 'better-auth-result-token',
      session: { id: 'private-session-id' },
    }))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client,
      fetchApi: async () => jsonResponse(authMe('main-only-csrf')),
    })

    const response = await gateway.handle({
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'sign-in-email',
      payload: { email: 'admin@example.com', password: 'manual-password' },
    })

    expect(response.ok).toBe(true)
    expect(response.data).toBeNull()
    expect(JSON.stringify(response)).not.toContain('better-auth-result-token')
    expect(JSON.stringify(response)).not.toContain('private-session-id')
    expect(gateway.requireAuthorizationContext().csrfToken).toBe('main-only-csrf')
  })

  it('clears Main authorization and notifies subscribers after sign-out', async () => {
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi: async () => jsonResponse(authMe('main-only-csrf')),
    })
    await gateway.handle(authRequest('projection'))
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    const response = await gateway.handle(authRequest('sign-out'))

    expect(response.ok).toBe(true)
    expect(response.data).toBeNull()
    expect(changed).toHaveBeenCalledOnce()
    expect(() => gateway.requireAuthorizationContext()).toThrow('请先完成桌面认证')
  })

  it('notifies Main subscribers when server-validated roles change in the same session', async () => {
    const fetchApi = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf')))
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf', [])))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi,
    })
    await gateway.handle(authRequest('projection'))
    const initial = gateway.requireAuthorizationContext()
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    await gateway.handle(authRequest('projection'))

    expect(changed).toHaveBeenCalledOnce()
    expect(gateway.currentAuthorizationContext()).toMatchObject({
      userId: initial.userId,
      csrfToken: initial.csrfToken,
      platformRoles: [],
      permissions: ['workspace:read'],
      revision: initial.revision + 1,
    })
  })

  it('clears the last menu identity when a refreshed server projection is invalid', async () => {
    const fetchApi = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authMe('same-csrf')))
      .mockResolvedValueOnce(jsonResponse({
        ...authMe('same-csrf'),
        platformRoles: ['forged-role'],
      }))
    const gateway = new DesktopAuthGateway('http://127.0.0.1:8000', {
      client: fakeClient(),
      fetchApi,
    })
    await gateway.handle(authRequest('projection'))
    const changed = vi.fn()
    gateway.onAuthorizationChanged(changed)

    const response = await gateway.handle(authRequest('projection'))

    expect(response.ok).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
    expect(gateway.currentAuthorizationContext()).toBeNull()
  })
})

function request() {
  return {
    version: 1 as const,
    requestId: crypto.randomUUID(),
    command: 'bootstrap',
    payload: {},
  }
}

function authRequest(command: 'projection' | 'sign-out') {
  return {
    version: 1 as const,
    requestId: crypto.randomUUID(),
    command,
    payload: {},
  }
}

function autoAuth(): DesktopAutoAuthConfig {
  return {
    email: 'admin@example.com',
    displayName: 'GeoForge 演示管理员',
    credentialFile: 'C:\\runtime\\desktop\\auto-auth.secret',
    allowAccountCreation: true,
  }
}

function fakeClient(): DesktopAuthClientPort {
  return {
    getCookie: vi.fn(() => ''),
    getSession: vi.fn(async () => ok(null)),
    signIn: { email: vi.fn(async () => ok(null)) },
    signUp: { email: vi.fn(async () => ok(null)) },
    signOut: vi.fn(async () => ok(null)),
  }
}

function session(email: string) {
  return {
    session: { id: 'session_1', userId: 'auth_1' },
    user: { id: 'auth_1', email, name: '管理员' },
  }
}

function ok(data: unknown) {
  return { data, error: null }
}

function failed(message: string) {
  return { data: null, error: { message, statusText: 'Unauthorized' } }
}

function authMe(
  csrfToken: string,
  platformRoles: Array<'platform_admin' | 'workspace_admin' | 'analyst' | 'viewer'> = [
    'platform_admin',
  ],
) {
  const now = '2026-07-29T00:00:00.000Z'
  return {
    user: {
      userId: 'user_1',
      subject: 'auth_1',
      email: 'admin@example.com',
      displayName: '管理员',
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    },
    defaultWorkspace: null,
    memberships: [],
    platformRoles,
    csrfToken,
    permissions: ['workspace:read'],
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
