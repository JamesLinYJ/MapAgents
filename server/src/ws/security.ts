// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 授权策略
//
//   文件:       security.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 集中维护 WS 控制命令的 CSRF 与 RBAC 规则。handler 只负责连接和分发，
// 每个命令在进入业务执行前必须经过这里的会话活跃性和资源 scope 校验。

import { StoreNotFoundError } from '../store/platformStore.js'
import type { AuthContext } from '../security/types.js'
import { assertDirectToolRunAllowed } from '../security/toolExecutionPolicy.js'
import type { ClientMsg } from './protocol.js'
import type { WsDependencies } from './dependencies.js'
import { optionalString, requiredString } from './payload.js'

const MUTATING_COMMANDS = new Set([
  'thread:create', 'thread:update', 'thread:delete', 'thread:fork', 'thread:compact',
  'thread:memory:update', 'thread:memory:rebuild',
  'thread:trash:restore', 'thread:trash:purge',
  'run:start', 'run:cancel', 'run:resume', 'run:respond-decision',
  'tool:run', 'tool-catalog:upsert', 'tool-catalog:delete',
  'runtime-config:update',
  'speech:authorization',
  'memory:write', 'memory:delete', 'memory:extract', 'memory:dream', 'memory:session:rebuild',
  'file:delete', 'layer:update', 'layer:delete',
])

export function assertWsCsrf(msg: ClientMsg, auth: AuthContext | undefined): void {
  if (!auth || !MUTATING_COMMANDS.has(msg.type)) return
  const token = msg.payload.csrfToken
  if (token !== auth.csrfToken) throw new Error('CSRF 校验失败。')
}

export function requireWsAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

export async function authorizeWsMessage(
  msg: ClientMsg,
  dependencies: WsDependencies,
  auth: AuthContext | null,
): Promise<void> {
  const security = dependencies.security
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  if (!(await security.auth.isAuthContextActive(auth))) {
    throw new Error('登录会话已失效，请重新登录。')
  }
  const payload = msg.payload
  switch (msg.type) {
    case 'workspace:bootstrap':
    case 'session:get-default':
      await security.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'session:get':
    case 'thread:list':
    case 'thread:trash:list':
    case 'run:list':
      return authorizeSession(dependencies, auth, requiredString(payload, 'sessionId'), 'read')
    case 'thread:create':
      return authorizeSession(dependencies, auth, requiredString(payload, 'sessionId'), 'create', 'thread')
    case 'thread:get':
    case 'thread:history':
    case 'thread:context':
    case 'thread:memory:get':
    case 'memory:session:get':
    case 'thread:subscribe':
      return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'read')
    case 'thread:update':
    case 'thread:compact':
    case 'thread:memory:update':
    case 'thread:memory:rebuild':
    case 'memory:session:rebuild':
      return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'update')
    case 'thread:delete':
      return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'delete')
    case 'thread:trash:restore':
      return authorizeTrashedThread(dependencies, auth, requiredString(payload, 'threadId'), 'update')
    case 'thread:trash:purge':
      return authorizeTrashedThread(dependencies, auth, requiredString(payload, 'threadId'), 'delete')
    case 'thread:fork':
      return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'read')
    case 'run:start': {
      const threadId = optionalString(payload.threadId)
      if (threadId) return authorizeThread(dependencies, auth, threadId, 'create', 'run')
      return authorizeSession(dependencies, auth, requiredString(payload, 'sessionId'), 'create', 'run')
    }
    case 'run:get':
    case 'run:subscribe':
      return authorizeRun(dependencies, auth, requiredString(payload, 'runId'), 'read')
    case 'run:cancel':
    case 'run:resume':
      return authorizeRun(dependencies, auth, requiredString(payload, 'runId'), 'execute')
    case 'run:respond-decision':
      return authorizeRun(dependencies, auth, requiredString(payload, 'runId'), 'approve')
    case 'tool:list':
      await security.authorization.enforce(auth, 'tool', 'read', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'tool:run':
      return assertDirectToolRunAllowed(auth, security.authorization, dependencies.toolRegistry, requiredString(payload, 'toolName'))
    case 'tool-catalog:list':
    case 'runtime-config:get':
    case 'provider:list':
    case 'system:get':
      await security.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'tool-catalog:upsert':
    case 'tool-catalog:delete':
    case 'runtime-config:update':
      await security.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'speech:authorization':
      await security.authorization.enforce(auth, 'speech', 'execute', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'memory:list':
    case 'memory:read':
    case 'memory:search':
    case 'memory:instructions:list':
      await security.authorization.enforce(auth, 'memory', 'read', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
      return
    case 'memory:write':
      await security.authorization.enforce(auth, 'memory', 'create', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
      return
    case 'memory:delete':
      await security.authorization.enforce(auth, 'memory', 'delete', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
      return
    case 'memory:extract':
    case 'memory:dream':
      await security.authorization.enforce(auth, 'memory', 'execute', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
      return
    case 'file:list':
      if (optionalString(payload.threadId)) return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'read')
      await security.authorization.enforce(auth, 'thread', 'read', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'file:delete':
      if (optionalString(payload.threadId)) return authorizeThread(dependencies, auth, requiredString(payload, 'threadId'), 'update')
      await security.authorization.enforce(auth, 'thread', 'update', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'layer:list':
      await security.authorization.enforce(auth, 'layer', 'read', { workspaceId: auth.defaultWorkspaceId })
      return
    case 'layer:update':
      return authorizeLayer(dependencies, auth, requiredString(payload, 'layerKey'), 'update')
    case 'layer:delete':
      return authorizeLayer(dependencies, auth, requiredString(payload, 'layerKey'), 'delete')
    case 'run:unsubscribe':
    case 'thread:unsubscribe':
      return
  }
}

async function authorizeSession(
  dependencies: WsDependencies,
  auth: AuthContext,
  sessionId: string,
  action: 'read' | 'create' | 'update' | 'delete',
  object: 'session' | 'thread' | 'run' = 'session',
): Promise<void> {
  const session = dependencies.store.getSession(sessionId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, object, action, {
    workspaceId: session.workspaceId,
    createdByUserId: session.createdByUserId,
    visibility: session.visibility,
    resourceId: session.id,
  })
}

async function authorizeThread(
  dependencies: WsDependencies,
  auth: AuthContext,
  threadId: string,
  action: 'read' | 'create' | 'update' | 'delete',
  object: 'thread' | 'run' = 'thread',
): Promise<void> {
  const thread = dependencies.store.getThread(threadId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, object, action, {
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    resourceId: thread.id,
  })
}

async function authorizeTrashedThread(
  dependencies: WsDependencies,
  auth: AuthContext,
  threadId: string,
  action: 'update' | 'delete',
): Promise<void> {
  const thread = await dependencies.store.getTrashedThread(threadId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'thread', action, {
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    resourceId: thread.id,
  })
}

async function authorizeRun(
  dependencies: WsDependencies,
  auth: AuthContext,
  runId: string,
  action: 'read' | 'execute' | 'approve',
): Promise<void> {
  const run = dependencies.store.getRun(runId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'run', action, {
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    resourceId: run.id,
  })
}

async function authorizeLayer(
  dependencies: WsDependencies,
  auth: AuthContext,
  layerKey: string,
  action: 'update' | 'delete',
): Promise<void> {
  const layer = await dependencies.postgis.getLayer(layerKey)
  if (!layer) throw new StoreNotFoundError(`图层 '${layerKey}' 不存在`)
  if (layer.readonly) throw new Error('系统图层为只读，不能修改。')
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'layer', action, {
    workspaceId: layer.workspaceId,
    createdByUserId: layer.createdByUserId,
    visibility: layer.visibility,
    resourceId: layer.layerKey,
  })
}
