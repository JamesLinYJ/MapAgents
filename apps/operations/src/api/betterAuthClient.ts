// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Better Auth 浏览器适配器
//
//   文件:       betterAuthClient.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createAuthClient } from 'better-auth/react'

const client = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/ops/auth',
})

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const result = await client.signIn.email({ email, password, rememberMe: false })
  if (result.error) throw new Error(result.error.message || '登录失败。')
}

export async function signOut(): Promise<void> {
  const result = await client.signOut()
  if (result.error) throw new Error(result.error.message || '退出登录失败。')
}
