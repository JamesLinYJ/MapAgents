// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面
//
//   文件:       handler.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import { OpenAIAgentsRuntime } from '../agent/runtime.js'
import { RuntimeFileStore } from '../store/fileStore.js'
import { PostgresPlatformStore, StoreNotFoundError } from '../store/platformStore.js'
import { makeId } from '../utils/ids.js'
import { failure, parseMessage, push, success, type ClientMsg } from './protocol.js'
import { sendRunSnapshot, sendWs, subscribeToRun } from './subscriptions.js'
import type { SecurityServices } from '../security/routes.js'
import { WsMessageRateLimiter } from '../security/rateLimiter.js'
import type { AuthContext } from '../security/types.js'
import type { WsDependencies } from './dependencies.js'
import { assertWsCsrf, authorizeWsMessage, requireWsAuth } from './security.js'
import { executeTool } from './toolCommand.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import { respondDecision } from './decisionCommand.js'
import { registerMemoryCommands } from './memoryCommand.js'
import { WsCommandRegistry, type WsCommandDefinition } from './commandRegistry.js'
import { registerCoreCommands } from './coreCommands.js'
import { registerThreadCommands } from './threadCommands.js'
import { registerControlCommands } from './controlCommands.js'
import { registerRunCommands } from './runCommands.js'
import { registerWorkspaceCommands } from './workspaceCommands.js'
import { registerThreadContextCommands } from './threadContextCommands.js'
import {
  formatError,
  optionalPositiveInteger,
  optionalString,
  requiredRecord,
  requiredRunProvider,
  requiredString,
} from './payload.js'

export function createWsHandler(server: Server, dependencies: WsDependencies) {
  const { store } = dependencies
  const runtime = new OpenAIAgentsRuntime(store, dependencies.toolRegistry, dependencies.modelRegistry, {
    createSandboxSession: dependencies.createSandboxSession,
  })
  const files = new RuntimeFileStore(dependencies.runtimeRoot)
  const commandRegistry = new WsCommandRegistry()
  registerCoreCommands(commandRegistry)
  registerWorkspaceCommands(commandRegistry)
  registerThreadCommands(commandRegistry)
  registerThreadContextCommands(commandRegistry)
  registerControlCommands(commandRegistry)
  registerRunCommands(commandRegistry)
  registerMemoryCommands(commandRegistry)
  const wss = new WebSocketServer({ noServer: true })
  const wsRateLimiter = new WsMessageRateLimiter()

  server.on('upgrade', async (request, socket, head) => {
    if (!isWsPath(request)) return
    const auth = await authenticateWsRequest(request, socket, dependencies.security)
    if (!auth) return
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request, auth))
  })

  wss.on('connection', (ws, _request, authContext?: AuthContext) => {
    const connectionId = makeId('ws_conn')
    const subscriptions = new Map<string, () => void>()
    const keepalive = setInterval(() => sendWs(ws, push('keepalive', {})), 30_000)

    ws.on('message', async (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        let msg: ClientMsg
        try {
          msg = parseMessage(line)
        } catch (error) {
          sendWs(ws, failure(null, 'invalid_request', formatError(error)))
          continue
        }
        if (!wsRateLimiter.consume(connectionId, msg.type)) {
          sendWs(ws, failure(msg.id, 'command_failed', '请求过于频繁，请稍后重试。'))
          continue
        }
        try {
          const registeredCommand = commandRegistry.get(msg.type)
          if (registeredCommand) assertRegisteredCommandCsrf(msg, authContext, registeredCommand)
          else assertWsCsrf(msg, authContext)
          await authorizeWsMessage(msg, dependencies, authContext ?? null)
          const result = registeredCommand
            ? await commandRegistry.execute(msg, { dependencies, runtime, files, ws, subscriptions, auth: authContext ?? null })
            : await handleMessage(msg, dependencies, runtime, files, ws, subscriptions, authContext ?? null)
          sendWs(ws, success(msg.id, result))
        } catch (error) {
          const code = error instanceof StoreNotFoundError ? 'not_found' : 'command_failed'
          sendWs(ws, failure(msg.id, code, formatError(error)))
        }
      }
    })

    ws.on('close', () => {
      clearInterval(keepalive)
      subscriptions.forEach(unsubscribe => unsubscribe())
      subscriptions.clear()
    })
  })

  return wss
}

function assertRegisteredCommandCsrf(
  msg: ClientMsg,
  auth: AuthContext | undefined,
  command: WsCommandDefinition,
): void {
  if (!command.csrf || !auth) return
  if (msg.payload.csrfToken !== auth.csrfToken) throw new Error('CSRF 校验失败。')
}

function isWsPath(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname === '/ws'
  } catch {
    return false
  }
}

async function authenticateWsRequest(
  request: IncomingMessage,
  socket: Duplex,
  security: SecurityServices,
): Promise<AuthContext | null> {
  const origin = request.headers.origin
  if (!security.auth.isTrustedOrigin(origin)) {
    rejectUpgrade(socket, 403, 'Forbidden origin')
    return null
  }
  const auth = await security.auth.authenticateRequest(toRequest(request))
  if (!auth) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return null
  }
  return auth
}

function toRequest(request: IncomingMessage): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  return new Request(new URL(request.url ?? '/ws', 'http://127.0.0.1').toString(), { headers })
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

async function resolveBootstrapSession(
  store: PostgresPlatformStore,
  auth: AuthContext,
  security: SecurityServices,
  requestedSessionId: string | null,
) {
  if (!requestedSessionId || requestedSessionId === PostgresPlatformStore.DEFAULT_SESSION_ID) {
    return store.getOrCreateUserDefaultSession({ workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
  }
  const session = store.getSession(requestedSessionId)
  await security.authorization.assertResourceWorkspace(auth, 'session', 'read', {
    workspaceId: session.workspaceId,
    createdByUserId: session.createdByUserId,
    visibility: session.visibility,
    resourceId: session.id,
  })
  return session
}

async function handleMessage(
  msg: ClientMsg,
  dependencies: WsDependencies,
  runtime: OpenAIAgentsRuntime,
  files: RuntimeFileStore,
  ws: WebSocket,
  subscriptions: Map<string, () => void>,
  auth: AuthContext | null,
): Promise<unknown> {
  const { store, toolRegistry, modelRegistry, postgis } = dependencies
  const payload = msg.payload
  const currentAuth = requireWsAuth(auth)
  switch (msg.type) {
    case 'workspace:bootstrap': {
      // 首屏只取稳定摘要；工具、配置、图层和完整运行快照由可见功能按需加载。
      const requestedSessionId = optionalString(payload.sessionId)
      const session = await resolveBootstrapSession(store, currentAuth, dependencies.security, requestedSessionId)
      return {
        session,
        threads: store.listThreadsForSession(session.id),
        providers: modelRegistry.descriptors(),
        auth: dependencies.security.auth.toAuthMe(currentAuth),
      }
    }
    case 'thread:context': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const tools = toolRegistry.list().map(tool => `- ${tool.name}: ${tool.description}`).join('\n')
      const systemPrompt = buildSystemPrompt(config, null, tools, '', '')
      return (await assembleThreadContext(store, threadId, config.context, systemPrompt)).report
    }
    case 'thread:compact': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      return compactThreadIfNeeded(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName)),
        true,
      )
    }
    case 'thread:memory:get':
      return handleMemoryCommand(msg.type, payload, dependencies)
    case 'thread:memory:update':
    case 'thread:memory:rebuild':
    case 'memory:list':
    case 'memory:read':
    case 'memory:write':
    case 'memory:delete':
    case 'memory:search':
    case 'memory:extract':
    case 'memory:dream':
    case 'memory:session:get':
    case 'memory:session:rebuild':
    case 'memory:instructions:list':
      return handleMemoryCommand(msg.type, payload, dependencies)
    case 'run:start': {
      const query = requiredString(payload, 'query')
      let threadId = optionalString(payload.threadId)
      const sessionId = optionalString(payload.sessionId) ?? (threadId ? store.getThread(threadId).sessionId : null)
      if (!sessionId) throw new Error('sessionId 不能为空')
      if (!threadId) threadId = (await store.createThread(sessionId, query.slice(0, 32))).id
      const config = await resolveRuntimeConfig(store, dependencies.defaultRuntimeConfig)
      const selectedProvider = optionalString(payload.provider)
        ?? optionalString(payload.modelProvider)
        ?? modelRegistry.defaultProvider
      if (!selectedProvider) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
      const run = await store.createRun(sessionId, query, {
        threadId,
        modelProvider: selectedProvider,
        modelName: optionalString(payload.modelName),
        runtimeConfigSnapshot: config,
      })
      subscribeToRun(ws, run.id, store, subscriptions)
      void runtime.run({
        runId: run.id,
        threadId,
        sessionId,
        query,
        provider: selectedProvider,
        modelName: run.modelName,
        runtimeConfig: config,
        executionMode: payload.executionMode === 'plan' ? 'plan' : 'auto',
        reasoning: payload.reasoning !== false,
        auth: currentAuth,
      }).then(() => void sendRunSnapshot(ws, run.id, store))
      return run
    }
    case 'run:resume': {
      const runId = requiredString(payload, 'runId')
      const run = store.getRun(runId)
      const checkpoint = await store.getRunCheckpoint(runId)
      if (checkpoint.pendingToolCallIds.length) {
        await store.updateRunStatus(runId, 'requires_action')
        throw new Error(`运行包含状态未知的工具调用，禁止自动重放：${checkpoint.pendingToolCallIds.join(', ')}`)
      }
      if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
      subscribeToRun(ws, runId, store, subscriptions)
      void runtime.run({
        runId,
        threadId: run.threadId,
        sessionId: run.sessionId,
        query: run.userQuery,
        provider: requiredRunProvider(run.modelProvider),
        modelName: run.modelName,
        runtimeConfig: run.runtimeConfigSnapshot,
        resume: true,
        auth: currentAuth,
      }).then(() => void sendRunSnapshot(ws, runId, store))
      return store.getRun(runId)
    }
    case 'run:respond-decision':
      return respondDecision(payload, dependencies, runtime, ws, subscriptions, currentAuth)
    case 'tool:run':
      return executeTool(payload, store, toolRegistry, modelRegistry, dependencies.defaultRuntimeConfig, dependencies.security, currentAuth)
  }
}


