// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 短期运维验证与恢复窗口
//
//   文件:       opsSessionWindow.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AuthContext } from '../security/types.js'
import { OPS_LIMITS } from './constants.js'

const payloadSchema = z.object({
  version: z.literal(1),
  purpose: z.enum(['recovery', 'step_up']),
  userId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
  csrfToken: z.string().min(32),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict()

export type OpsSessionWindow = z.infer<typeof payloadSchema>

export class OpsSessionWindowCodec {
  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
  ) {
    if (secret.length < 32) throw new Error('运维恢复会话密钥长度不足。')
  }

  issueRecovery(auth: AuthContext, now = Date.now()) {
    return this.issue('recovery', auth, now)
  }

  issueStepUp(auth: AuthContext, now = Date.now()) {
    return this.issue('step_up', auth, now)
  }

  readRecoveryCookie(cookieHeader: string | undefined, now = Date.now()): OpsSessionWindow | null {
    return this.readCookie('recovery', cookieHeader, now)
  }

  readStepUpCookie(cookieHeader: string | undefined, now = Date.now()): OpsSessionWindow | null {
    return this.readCookie('step_up', cookieHeader, now)
  }

  private issue(purpose: 'recovery' | 'step_up', auth: AuthContext, now: number): {
    token: string
    payload: OpsSessionWindow
    cookie: string
  } {
    const payload = payloadSchema.parse({
      version: 1,
      purpose,
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      csrfToken: randomBytes(32).toString('base64url'),
      issuedAt: now,
      expiresAt: now + OPS_LIMITS.stepUpWindowSeconds * 1_000,
    })
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = this.sign(encoded)
    const token = `${encoded}.${signature}`
    const cookieName = cookieNameFor(purpose)
    const cookie = [
      `${cookieName}=${token}`,
      'Path=/',
      `Max-Age=${OPS_LIMITS.stepUpWindowSeconds}`,
      'HttpOnly',
      'SameSite=Strict',
      ...(this.secure ? ['Secure'] : []),
    ].join('; ')
    return { token, payload, cookie }
  }

  private readCookie(
    purpose: 'recovery' | 'step_up',
    cookieHeader: string | undefined,
    now: number,
  ): OpsSessionWindow | null {
    if (!cookieHeader) return null
    const cookieName = cookieNameFor(purpose)
    const token = cookieHeader.split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
    const payload = token ? this.verify(token, now) : null
    return payload?.purpose === purpose ? payload : null
  }

  verify(token: string, now = Date.now()): OpsSessionWindow | null {
    const [encoded, signature, extra] = token.split('.')
    if (!encoded || !signature || extra) return null
    if (!isCanonicalBase64Url(encoded) || !isCanonicalBase64Url(signature)) return null
    const expected = Buffer.from(this.sign(encoded), 'base64url')
    const actual = Buffer.from(signature, 'base64url')
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null
    try {
      const payload = payloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown)
      return payload.expiresAt > now ? payload : null
    } catch {
      return null
    }
  }

  clearCookies(): string[] {
    return (['recovery', 'step_up'] as const).map(purpose => [
      `${cookieNameFor(purpose)}=`,
      'Path=/',
      'Max-Age=0',
      'HttpOnly',
      'SameSite=Strict',
      ...(this.secure ? ['Secure'] : []),
    ].join('; '))
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret).update(encoded).digest('base64url')
  }
}

function isCanonicalBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false
  return Buffer.from(value, 'base64url').toString('base64url') === value
}

function cookieNameFor(purpose: 'recovery' | 'step_up'): string {
  return purpose === 'recovery' ? 'geoforge_ops_recovery' : 'geoforge_ops_step_up'
}
