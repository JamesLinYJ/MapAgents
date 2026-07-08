// +-------------------------------------------------------------------------
//
//   地理智能平台 - 认证与 RBAC 管理路由
//
//   文件:       routes.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import type { Database } from '../db/connection.js'
import { platformRoleSchema } from '../schemas/types.js'
import { BetterAuthService } from './authService.js'
import { SecurityAdminStore } from './adminStore.js'
import { AuthorizationError, AuthorizationService } from './authorizationService.js'
import type { AuthContext } from './types.js'

export interface SecurityServices {
  auth: BetterAuthService
  authorization: AuthorizationService
  db: Database
}

export function securityRoutes(services: SecurityServices) {
  const app = new Hono()
  const adminStore = new SecurityAdminStore(services.db)

  app.get('/api/v1/auth/me', c => {
    const auth = getAuth(c)
    if (!auth) return c.json({ detail: '未登录' }, 401)
    return c.json(services.auth.toAuthMe(auth))
  })

  app.get('/api/v1/admin/users', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await adminStore.listUsers())
  })

  app.patch('/api/v1/admin/users/:userId', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const status = typeof body.status === 'string' ? body.status : null
    const displayName = typeof body.displayName === 'string' ? body.displayName : null
    await adminStore.updateUser(c.req.param('userId'), { displayName, status })
    if (status === 'disabled') await services.auth.revokeUserSessionsByPlatformUserId(c.req.param('userId'))
    return c.json({ updated: true })
  })

  app.get('/api/v1/admin/workspaces', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
    const isPlatformAdmin = auth.roles.some(role => role.role === 'platform_admin')
    return c.json(await adminStore.listWorkspaces({ platformAdmin: isPlatformAdmin, userId: auth.userId }))
  })

  app.post('/api/v1/admin/workspaces', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const name = requiredString(body.name, '工作区名称')
    const description = typeof body.description === 'string' ? body.description : ''
    const workspace = await adminStore.createWorkspaceWithAdmin({ name, description, createdByUserId: auth.userId })
    return c.json(workspace, 201)
  })

  app.get('/api/v1/admin/memberships', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const workspaceId = c.req.query('workspaceId') ?? auth.defaultWorkspaceId
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    return c.json(await adminStore.listMemberships(workspaceId))
  })

  app.post('/api/v1/admin/memberships', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const workspaceId = requiredString(body.workspaceId, 'workspaceId')
    const userId = requiredString(body.userId, 'userId')
    const role = platformRoleSchema.parse(requiredString(body.role, 'role'))
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    await adminStore.addMembership({ workspaceId, userId, role })
    return c.json({ created: true })
  })

  app.delete('/api/v1/admin/memberships/:membershipId', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const workspaceId = await adminStore.getMembershipWorkspace(c.req.param('membershipId'))
    if (!workspaceId) return c.json({ detail: '成员关系不存在' }, 404)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    await adminStore.deleteMembership(c.req.param('membershipId'))
    return c.json({ deleted: true })
  })

  app.get('/api/v1/admin/roles', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await adminStore.listRoles())
  })

  app.get('/api/v1/admin/audit-events', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    return c.json(await adminStore.listAuditEvents())
  })

  return app
}

export async function authMiddleware(services: SecurityServices, c: { req: { raw: Request; header(name: string): string | undefined }; set(key: string, value: unknown): void }, next: () => Promise<void>) {
  const auth = await services.auth.authenticateRequest(c.req.raw)
  if (auth) c.set('auth', auth)
  await next()
}

export async function requireHttpAuth(services: SecurityServices, c: { req: { raw: Request; path: string; method: string; header(name: string): string | undefined }; set(key: string, value: unknown): void; json(value: unknown, status?: number): Response }, next: () => Promise<void>) {
  const auth = await services.auth.authenticateRequest(c.req.raw)
  if (!auth) return c.json({ detail: '未登录' }, 401)
  c.set('auth', auth)
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method.toUpperCase())) {
    try {
      services.auth.requireCsrf(c.req.raw, auth)
    } catch (error) {
      return c.json({ detail: formatError(error, 'CSRF 校验失败') }, 403)
    }
  }
  await next()
}

export function getAuth(c: { get(key: string): unknown }): AuthContext | null {
  const value = c.get('auth')
  return isAuthContext(value) ? value : null
}

export function requireAuth(c: { get(key: string): unknown }): AuthContext {
  const auth = getAuth(c)
  if (!auth) throw new AuthorizationError('未登录。')
  return auth
}

function isAuthContext(value: unknown): value is AuthContext {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { userId?: unknown }).userId === 'string'
    && typeof (value as { authSessionId?: unknown }).authSessionId === 'string'
    && typeof (value as { defaultWorkspaceId?: unknown }).defaultWorkspaceId === 'string'
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  return value.trim()
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}
