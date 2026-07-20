// +-------------------------------------------------------------------------
//
//   地理智能平台 - Playwright 认证会话准备
//
//   文件:       globalSetup.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { request, type FullConfig } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// 浏览器验收必须经过真实 Better Auth 边界。这里登录稳定的测试账号；账号
// 尚不存在时才走公开注册，并在进入用例前用 /auth/me 证明 Cookie 会话有效。
export default async function globalSetup(config: FullConfig): Promise<void> {
  const project = config.projects[0]
  const storageState = project?.use.storageState
  if (typeof storageState !== 'string') {
    throw new Error('Playwright 项目必须配置文件形式的 storageState')
  }

  const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173'
  const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://127.0.0.1:8000'
  const email = process.env.PLAYWRIGHT_E2E_EMAIL ?? 'geoforge-e2e@example.com'
  const password = process.env.PLAYWRIGHT_E2E_PASSWORD ?? 'GeoForge-E2E-Password-2026!'
  const api = await request.newContext({
    baseURL: apiBaseUrl,
    extraHTTPHeaders: { Origin: webBaseUrl },
  })

  try {
    const signIn = await api.post('/api/auth/sign-in/email', {
      data: { email, password },
    })
    if (!signIn.ok()) {
      const signUp = await api.post('/api/auth/sign-up/email', {
        data: { name: 'GeoForge E2E', email, password },
      })
      if (!signUp.ok()) {
        throw new Error(`Playwright 测试账号登录和注册均失败（HTTP ${signIn.status()}/${signUp.status()}）`)
      }
    }

    const authenticated = await api.get('/api/v1/auth/me')
    if (!authenticated.ok()) {
      throw new Error(`Playwright Better Auth 会话校验失败（HTTP ${authenticated.status()}）`)
    }
    await mkdir(dirname(storageState), { recursive: true })
    await api.storageState({ path: storageState })
  } finally {
    await api.dispose()
  }
}
