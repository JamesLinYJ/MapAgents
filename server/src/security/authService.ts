// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 认证服务
//
//   文件:       authService.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import type { Database } from '../db/connection.js'
import { authAccount, authSession, authUser, authVerification } from '../db/schema.js'
import type { Env } from '../framework/env.js'
import type { AuthContext, AuthRoleBinding } from './types.js'
import type { AuthMe } from '../schemas/types.js'
import type { PlatformIdentityService } from './platformIdentityService.js'

const betterAuthSessionProjectionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
    expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  }),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean().optional(),
  }),
})

type BetterAuthSessionProjection = z.infer<typeof betterAuthSessionProjectionSchema>

function createBetterAuthRuntime(db: Database, env: Env, trustedOrigins: string[]) {
  return betterAuth({
      appName: 'GeoForge',
      baseURL: env.BETTER_AUTH_URL,
      basePath: '/api/auth',
      secret: env.BETTER_AUTH_SECRET,
      trustedOrigins,
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
        },
      }),
      emailAndPassword: {
        enabled: true,
        disableSignUp: !env.BETTER_AUTH_ALLOW_SIGN_UP,
        requireEmailVerification: env.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION,
        minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
        autoSignIn: true,
      },
      session: {
        expiresIn: 60 * 60 * 12,
        updateAge: 60 * 60,
      },
    })
}

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>

export class BetterAuthService {
  readonly auth: BetterAuthRuntime
  private readonly env: Env
  private readonly identity: PlatformIdentityService

  constructor(input: { db: Database; env: Env; identity: PlatformIdentityService }) {
    this.env = input.env
    this.identity = input.identity
    this.auth = createBetterAuthRuntime(input.db, input.env, [...this.trustedOrigins()])
  }

  handler(request: Request): Promise<Response> {
    return this.auth.handler(request)
  }

  async authenticateRequest(request: Request): Promise<AuthContext | null> {
    return this.authenticateHeaders(request.headers)
  }

  async authenticateHeaders(headers: Headers): Promise<AuthContext | null> {
    const session = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    })
    if (!session) return null
    return this.ensurePlatformProjection(betterAuthSessionProjectionSchema.parse(session))
  }

  requireCsrf(request: Request, auth: AuthContext): void {
    const configured = this.env.CSRF_HEADER_NAME
    const headerValue = request.headers.get(configured) ?? request.headers.get(configured.toLowerCase())
    if (!headerValue || headerValue !== auth.csrfToken) {
      throw new Error('CSRF 校验失败。')
    }
  }

  isTrustedOrigin(origin?: string | null): boolean {
    if (!origin) return false
    return this.trustedOrigins().has(origin.replace(/\/+$/u, ''))
  }

  trustedOrigins(): Set<string> {
    const origins = [
      ...this.env.TRUSTED_ORIGINS.split(','),
      this.env.APP_BASE_URL,
      this.env.WEB_BASE_URL ?? '',
      this.env.BETTER_AUTH_URL,
    ]
    return new Set(origins.map(item => item.trim().replace(/\/+$/u, '')).filter(Boolean))
  }

  toAuthMe(auth: AuthContext): AuthMe {
    return {
      user: {
        userId: auth.userId,
        subject: auth.subject,
        email: auth.email,
        displayName: auth.displayName,
        status: 'active',
        lastLoginAt: null,
        createdAt: '',
        updatedAt: '',
      },
      defaultWorkspace: null,
      memberships: auth.roles.map(role => ({
        membershipId: `${role.workspaceId}:${role.role}`,
        workspaceId: role.workspaceId,
        userId: auth.userId,
        role: role.role,
        createdAt: '',
      })),
      platformRoles: [...new Set(auth.roles.map(role => role.role))],
      csrfToken: auth.csrfToken,
      permissions: [],
    }
  }

  async revokeUserSessionsByPlatformUserId(platformUserId: string): Promise<void> {
    await this.identity.revokePlatformUserSessions(platformUserId)
  }

  private async ensurePlatformProjection(session: BetterAuthSessionProjection): Promise<AuthContext | null> {
    const authUserId = requireString(session.user.id, 'Better Auth user id')
    const email = requireString(session.user.email, 'Better Auth email').toLowerCase()
    const displayName = requireString(session.user.name || email, 'Better Auth user name')
    const platformUserId = platformUserIdFor(authUserId)
    const { user: platformUser, roles } = await this.identity.ensureProjection({
      platformUserId,
      authUserId,
      email,
      displayName,
      personalWorkspaceId: workspaceIdFor(email),
      bootstrapAdmin: this.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === email,
    })
    if (platformUser.status !== 'active') {
      await this.identity.revokeAuthUserSessions(authUserId)
      return null
    }
    if (!roles.length) return null
    return {
      userId: platformUser.userId,
      subject: authUserId,
      email,
      displayName,
      authSessionId: session.session.id,
      authSessionExpiresAt: normalizeDateString(session.session.expiresAt),
      csrfToken: this.csrfForSession(session.session.id),
      defaultWorkspaceId: pickDefaultWorkspace(roles),
      roles,
    }
  }

  async isAuthContextActive(auth: AuthContext): Promise<boolean> {
    return this.identity.isAuthSessionActive(auth.authSessionId)
  }

  async listUserRoles(userId: string): Promise<AuthRoleBinding[]> {
    return this.identity.listUserRoles(userId)
  }

  async buildServiceAuthContext(platformUserId: string, workspaceId: string): Promise<AuthContext> {
    const user = await this.identity.getUser(platformUserId)
    if (!user || user.status !== 'active') {
      throw new Error('Workflow 创建者已禁用或不存在，任务不会执行。')
    }
    const roles = await this.listUserRoles(platformUserId)
    const hasWorkspaceRole = roles.some(role => role.role === 'platform_admin' || role.workspaceId === workspaceId)
    if (!hasWorkspaceRole) {
      throw new Error('Workflow 创建者已失去当前工作区权限，任务不会执行。')
    }
    return {
      userId: user.userId,
      subject: user.subject,
      email: user.email.toLowerCase(),
      displayName: user.displayName,
      authSessionId: `workflow:${user.userId}`,
      authSessionExpiresAt: null,
      csrfToken: '',
      defaultWorkspaceId: workspaceId,
      roles,
    }
  }

  private csrfForSession(sessionId: string): string {
    return createHmac('sha256', this.env.BETTER_AUTH_SECRET).update(`csrf:${sessionId}`).digest('base64url')
  }
}

function platformUserIdFor(authUserId: string): string {
  return `user_${createHash('sha256').update(authUserId).digest('hex').slice(0, 24)}`
}

function workspaceIdFor(email: string): string {
  return `workspace_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`
}

function pickDefaultWorkspace(roles: AuthRoleBinding[]): string {
  const workspaceRole = roles.find(item => item.role === 'workspace_admin')
    ?? roles.find(item => item.role === 'analyst')
    ?? roles.find(item => item.role === 'viewer')
    ?? roles[0]
  if (!workspaceRole) throw new Error('用户没有任何工作区成员关系。')
  return workspaceRole.workspaceId
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺失。`)
  return value.trim()
}

function normalizeDateString(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
