// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 限流中间件（Hono）
//
//   文件:       httpRateLimit.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Context, Next } from 'hono'
import { clientIp, createApiRateLimiter, createAuthRateLimiter } from './rateLimiter.js'
import type { SecurityServices } from './routes.js'

const authLimiter = createAuthRateLimiter()
const apiLimiter = createApiRateLimiter()

/** Better Auth 登录/注册路径按 IP+邮箱限流 */
export async function authRateLimitMiddleware(c: Context, next: Next): Promise<void | Response> {
  const ip = clientIp(c.req.raw, { remoteAddress: requestRemoteAddress(c) })
  const body = await tryReadBody(c)
  const email = body.email
  const key = typeof email === 'string' && email.trim()
    ? `auth:${ip}:${email.trim().toLowerCase()}`
    : `auth:${ip}`

  if (!authLimiter.consume(key)) {
    return c.json({ detail: '请求过于频繁，请稍后重试。' }, 429)
  }
  await next()
}

/** /api/v1/* 按用户或 IP 限流 */
export function apiRateLimitMiddleware(security: SecurityServices) {
  return async (c: Context, next: Next): Promise<void | Response> => {
    const ip = clientIp(c.req.raw, { remoteAddress: requestRemoteAddress(c) })
    let userId: string | null = null
    try {
      const auth = await security.auth.authenticateRequest(c.req.raw)
      userId = auth?.userId ?? null
    } catch {
      // 认证状态不可用时仅改变限流维度；后续鉴权仍决定请求能否进入业务处理。
    }
    const key = userId ? `api:user:${userId}` : `api:ip:${ip}`

    if (!apiLimiter.consume(key)) {
      return c.json({ detail: '请求过于频繁，请稍后重试。' }, 429)
    }
    await next()
  }
}

interface AuthBody {
  email?: unknown
}

function requestRemoteAddress(c: Context): string | null {
  const environment = c.env as {
    incoming?: { socket?: { remoteAddress?: string | undefined } }
  } | undefined
  return environment?.incoming?.socket?.remoteAddress ?? null
}

async function tryReadBody(c: Context): Promise<AuthBody> {
  if (c.req.method !== 'POST') return {}
  try {
    const cloned = c.req.raw.clone()
    const text = await cloned.text()
    return JSON.parse(text) as AuthBody
  } catch {
    return {}
  }
}
