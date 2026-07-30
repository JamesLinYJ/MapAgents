// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面
//
//   文件:       handler.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { RuntimeFileStore } from '../store/fileStore.js'
import { StoreNotFoundError } from '../store/storeErrors.js'
import { AuthorizationError } from '../security/authorizationService.js'
import { makeId } from '../utils/ids.js'
import { failure, parseMessage, push, success, type ClientMsg } from './protocol.js'
import { sendWs } from './subscriptions.js'
import type { SecurityServices } from '../security/routes.js'
import { WsMessageRateLimiter } from '../security/rateLimiter.js'
import type { AuthContext } from '../security/types.js'
import type { WsDependencies } from './dependencies.js'
import type { WsCommandDefinition } from './commandRegistry.js'
import { createDefaultCommandRegistry } from './defaultCommandRegistry.js'
import { formatError } from './payload.js'
import { errorLogPayload, logger, traceId, withLogContext } from '../observability/logger.js'
import { wsConnectionsActive, wsMessagesTotal } from '../observability/metrics.js'

export function createWsHandler(server: Server, dependencies: WsDependencies) {
  const runtime = dependencies.runtime
  const runTasks = dependencies.runTasks
  const files = new RuntimeFileStore(dependencies.runtimeRoot)
  const commandRegistry = createDefaultCommandRegistry()
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
    wsConnectionsActive.inc()
    logger.info({ wsConnectionId: connectionId, userId: authContext?.userId ?? null }, 'ws connected')

    ws.on('message', async (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        await withLogContext({
          traceId: traceId(),
          wsConnectionId: connectionId,
          userId: authContext?.userId ?? null,
        }, async () => {
          let msg: ClientMsg
          try {
            msg = parseMessage(line)
          } catch (error) {
            logger.warn({ error: errorLogPayload(error) }, 'ws invalid message')
            wsMessagesTotal.inc({ type: 'invalid', direction: 'inbound' })
            sendWs(ws, failure(null, 'invalid_request', formatError(error)))
            wsMessagesTotal.inc({ type: 'invalid', direction: 'outbound' })
            return
          }
          await withLogContext({ wsCommand: msg.type, wsRequestId: msg.id }, async () => {
            wsMessagesTotal.inc({ type: msg.type, direction: 'inbound' })
            if (!wsRateLimiter.consume(connectionId, msg.type)) {
              logger.warn({ command: msg.type }, 'ws rate limited')
              sendWs(ws, failure(msg.id, 'command_failed', '请求过于频繁，请稍后重试。'))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
              return
            }
            try {
              const registeredCommand = commandRegistry.get(msg.type)
              if (!registeredCommand) throw new Error(`WS 命令 '${msg.type}' 尚未注册。`)
              assertRegisteredCommandCsrf(msg, authContext, registeredCommand)
              const result = await commandRegistry.execute(msg, { dependencies, runtime, runTasks, files, ws, subscriptions, auth: authContext ?? null })
              sendWs(ws, success(msg.id, result))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
            } catch (error) {
              const code = error instanceof StoreNotFoundError ? 'not_found'
                : error instanceof AuthorizationError ? 'forbidden'
                : 'command_failed'
              logger.warn({ error: errorLogPayload(error), code }, 'ws command failed')
              sendWs(ws, failure(msg.id, code, formatError(error)))
              wsMessagesTotal.inc({ type: msg.type, direction: 'outbound' })
            }
          })
        })
      }
    })

    ws.on('close', () => {
      clearInterval(keepalive)
      subscriptions.forEach(unsubscribe => unsubscribe())
      subscriptions.clear()
      wsConnectionsActive.dec()
      logger.info({ wsConnectionId: connectionId, userId: authContext?.userId ?? null }, 'ws disconnected')
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
  if (msg.meta?.csrfToken !== auth.csrfToken) throw new Error('CSRF 校验失败。')
}

function isWsPath(request: IncomingMessage): boolean {
  const rawPath = (request.url ?? '').split('?', 1)[0]
  return rawPath === '/ws'
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
  const headers = toHeaders(request)
  const auth = await security.auth.authenticateHeaders(headers)
    ?? (isLoopbackAddress(request.socket.remoteAddress)
      ? await security.auth.authenticateLocalAgentHeaders(headers)
      : null)
  if (!auth) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return null
  }
  return auth
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.trim().toLowerCase()
  if (normalized === '::1') return true
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4)
}

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  return headers
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}
