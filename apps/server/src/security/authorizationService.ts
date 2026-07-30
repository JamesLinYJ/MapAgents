// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin RBAC 授权服务
//
//   文件:       authorizationService.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { newEnforcer, newModelFromString, type Enforcer } from 'casbin'
import type { Database } from '../db/connection.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import type { AuthContext, AuthorizationScope, RbacAction, RbacObject } from './types.js'
import { CasbinPostgresAdapter } from './casbinPostgresAdapter.js'

const RBAC_MODEL = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act, eft

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = r.sub == p.sub && (p.dom == "*" || r.dom == p.dom) && (p.obj == "*" || r.obj == p.obj) && actionMatch(r.act, p.act)
`

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export class AuthorizationService {
  private enforcerPromise: Promise<Enforcer> | null = null

  constructor(
    private readonly db: Database,
    private readonly auditStore: AuditStore,
  ) {}

  async enforce(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope = {},
  ): Promise<void> {
    const allowed = await this.can(auth, object, action, scope)
    await this.audit(auth, object, action, scope, allowed ? 'allowed' : 'denied')
    if (!allowed) {
      const resource = scope.resourceId ? ` '${scope.resourceId}'` : ''
      throw new AuthorizationError(`无权限对 ${object}${resource} 执行 ${action}。`)
    }
  }

  async can(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope = {},
  ): Promise<boolean> {
    const workspaceId = scope.workspaceId ?? auth.defaultWorkspaceId
    const domain = workspaceId ? `workspace:${workspaceId}` : '*'
    const enforcer = await this.enforcer()
    const roles = auth.roles
    for (const binding of roles) {
      if (binding.role !== 'platform_admin' && workspaceId && binding.workspaceId !== workspaceId) continue
      const roleDomain = binding.role === 'platform_admin' ? '*' : `workspace:${binding.workspaceId}`
      if (await enforcer.enforce(binding.role, roleDomain === '*' ? '*' : domain, object, action)) return true
    }
    return false
  }

  async assertResourceWorkspace(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    resource: { workspaceId?: string | null; createdByUserId?: string | null; visibility?: string | null; resourceId?: string | null },
  ): Promise<void> {
    const workspaceId = resource.workspaceId
    if (!workspaceId) {
      throw new AuthorizationError(`资源 '${resource.resourceId ?? object}' 缺少 workspaceId，必须先执行归属迁移。`)
    }
    await this.enforce(auth, object, action, {
      workspaceId,
      userId: resource.createdByUserId ?? null,
      visibility: resource.visibility ?? null,
      resourceId: resource.resourceId ?? null,
    })
  }

  async audit(
    auth: AuthContext | null,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope,
    outcome: 'allowed' | 'denied' | 'error',
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const requestedWorkspaceId = scope.workspaceId ?? null
    const boundWorkspaceId = requestedWorkspaceId && auth?.roles.some(
      binding => binding.workspaceId === requestedWorkspaceId,
    )
      ? requestedWorkspaceId
      : null
    await this.auditStore.recordEvent({
      actorUserId: auth?.userId ?? null,
      workspaceId: boundWorkspaceId,
      action,
      objectType: object,
      objectId: scope.resourceId ?? null,
      outcome,
      metadata: requestedWorkspaceId && !boundWorkspaceId
        ? { ...metadata, requestedWorkspaceId }
        : metadata,
    })
  }

  async reload(): Promise<void> {
    this.enforcerPromise = null
    await this.enforcer()
  }

  private async enforcer(): Promise<Enforcer> {
    if (!this.enforcerPromise) {
      const model = newModelFromString(RBAC_MODEL)
      this.enforcerPromise = newEnforcer(model, new CasbinPostgresAdapter(this.db)).then(enforcer => {
        enforcer.addFunction('actionMatch', actionMatch)
        return enforcer
      })
    }
    return this.enforcerPromise
  }
}

export function actionMatch(requestAction: unknown, policyAction: unknown): boolean {
  if (typeof requestAction !== 'string' || typeof policyAction !== 'string') return false
  return policyAction === '*' || policyAction.split('|').map(item => item.trim()).includes(requestAction)
}
