// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Ops Gateway 身份与二次验证
//
//   文件:       opsAuthenticator.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { BetterAuthService } from '../security/authService.js'
import type { AuthContext } from '../security/types.js'
import { isDatabaseUnavailable } from '../db/databaseAvailability.js'
import type { OpsAuditService } from './opsAuditService.js'
import { OpsError } from './opsError.js'
import { OpsSessionWindowCodec, type OpsSessionWindow } from './opsSessionWindow.js'

export interface OpsPrincipal {
  userId: string
  email: string
  displayName: string
  csrfToken: string
  recoveryMode: boolean
  auth: AuthContext | null
}

export interface StepUpResult {
  cookie: string
  expiresAt: string
  authCookies: string[]
}

/**
 * 正常请求始终以 Better Auth + 平台角色为事实源；只有数据库调用抛错时，
 * 才允许最近签发的 recovery cookie 进入受限恢复模式。
 */
export class OpsAuthenticator {
  readonly windows: OpsSessionWindowCodec

  constructor(private readonly input: {
    auth: BetterAuthService
    audit: OpsAuditService
    recoverySecret: string
    secureCookies: boolean
    trustedOrigins: Set<string>
    csrfHeaderName: string
  }) {
    this.windows = new OpsSessionWindowCodec(input.recoverySecret, input.secureCookies)
  }

  requireTrustedRequest(request: Request): void {
    const origin = request.headers.get('origin')?.replace(/\/+$/u, '')
    if (origin && this.input.trustedOrigins.has(origin)) return
    const sameOriginNavigation = ['GET', 'HEAD'].includes(request.method.toUpperCase())
      && request.headers.get('sec-fetch-site') === 'same-origin'
    if (sameOriginNavigation) return
    throw new OpsError('forbidden', 403, '请求来源不受信任。')
  }

  async authenticate(request: Request, allowRecovery = false): Promise<OpsPrincipal> {
    let auth: AuthContext | null
    try {
      auth = await this.input.auth.authenticateRequest(request)
    } catch (error) {
      if (allowRecovery && isDatabaseUnavailable(error)) {
        const recovery = this.windows.readRecoveryCookie(request.headers.get('cookie') ?? undefined)
        if (recovery) return principalFromWindow(recovery)
      }
      throw error
    }
    if (!auth) throw new OpsError('unauthorized', 401, '请先登录 GeoForge。')
    if (!auth.roles.some(role => role.role === 'platform_admin')) {
      await this.input.audit.recordEvent({
        actorUserId: auth.userId,
        workspaceId: null,
        action: 'ops.access',
        objectType: 'operations_gateway',
        objectId: null,
        outcome: 'denied',
        metadata: {},
      })
      throw new OpsError('forbidden', 403, '仅平台管理员可以访问运维后台。')
    }
    return {
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      csrfToken: auth.csrfToken,
      recoveryMode: false,
      auth,
    }
  }

  requireCsrf(request: Request, principal: OpsPrincipal): void {
    const value = request.headers.get(this.input.csrfHeaderName)
    if (!value || value !== principal.csrfToken) {
      throw new OpsError('forbidden', 403, 'CSRF 校验失败。')
    }
  }

  requireStepUp(request: Request, principal: OpsPrincipal): OpsSessionWindow {
    if (principal.recoveryMode) {
      throw new OpsError('forbidden', 403, '数据库恢复模式不允许执行此操作。')
    }
    const window = this.windows.readStepUpCookie(request.headers.get('cookie') ?? undefined)
    if (!window || window.userId !== principal.userId) {
      throw new OpsError('forbidden', 403, '此操作需要重新验证当前账户密码。')
    }
    return window
  }

  stepUpExpiresAt(request: Request, principal: OpsPrincipal): string | null {
    const window = this.windows.readStepUpCookie(request.headers.get('cookie') ?? undefined)
    return window?.userId === principal.userId ? new Date(window.expiresAt).toISOString() : null
  }

  issueRecovery(principal: OpsPrincipal): { cookie: string; expiresAt: string } {
    if (!principal.auth) throw new OpsError('forbidden', 403, '恢复模式不能续签恢复会话。')
    const issued = this.windows.issueRecovery(principal.auth)
    return { cookie: issued.cookie, expiresAt: new Date(issued.payload.expiresAt).toISOString() }
  }

  async verifyPassword(request: Request, principal: OpsPrincipal, password: string): Promise<StepUpResult> {
    if (!principal.auth) throw new OpsError('forbidden', 403, '恢复模式不能执行密码二次验证。')
    let response: Response
    try {
      response = await this.input.auth.auth.api.signInEmail({
        body: { email: principal.email, password, rememberMe: false },
        headers: request.headers,
        asResponse: true,
      })
    } catch {
      await this.recordStepUp(principal.userId, 'denied')
      throw new OpsError('forbidden', 403, '密码验证失败。')
    }
    if (!response.ok) {
      await this.recordStepUp(principal.userId, 'denied')
      throw new OpsError('forbidden', 403, '密码验证失败。')
    }
    const issued = this.windows.issueStepUp(principal.auth)
    await this.recordStepUp(principal.userId, 'allowed')
    return {
      cookie: issued.cookie,
      expiresAt: new Date(issued.payload.expiresAt).toISOString(),
      authCookies: response.headers.getSetCookie(),
    }
  }

  private recordStepUp(actorUserId: string, outcome: 'allowed' | 'denied'): Promise<void> {
    return this.input.audit.recordEvent({
      actorUserId,
      workspaceId: null,
      action: 'ops.step_up',
      objectType: 'operations_gateway',
      objectId: null,
      outcome,
      metadata: {},
    })
  }
}

function principalFromWindow(window: OpsSessionWindow): OpsPrincipal {
  return {
    userId: window.userId,
    email: window.email,
    displayName: window.displayName,
    csrfToken: window.csrfToken,
    recoveryMode: true,
    auth: null,
  }
}
