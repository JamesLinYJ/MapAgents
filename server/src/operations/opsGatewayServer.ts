// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Ops Gateway HTTP 与 WebSocket 服务
//
//   文件:       opsGatewayServer.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createServer, type IncomingMessage } from 'node:http'
import {
  opsBootstrapSchema,
  opsControlCommandSchema,
  opsPushEventSchema,
  opsServiceActionSchema,
  opsServiceIdSchema,
  opsStepUpRequestSchema,
  opsStepUpResponseSchema,
  opsTerminalClientControlSchema,
  opsTerminalServerControlSchema,
  opsTranscriptAccessRequestSchema,
  type OpsControlCommand,
  type OpsLogLevel,
  type OpsServiceId,
} from '@geo-agent-platform/shared-types/operations'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { z } from 'zod'

import { errorLogPayload, logger } from '../observability/logger.js'
import { clientIp, SlidingWindowRateLimiter, WsMessageRateLimiter } from '../security/rateLimiter.js'
import { brokerTerminalServerMessageSchema } from './brokerProtocol.js'
import { OPS_LIMITS, OPS_SERVICE_METADATA } from './constants.js'
import type { OpsGatewayContainer } from './opsGatewayContainer.js'
import type { OpsPrincipal } from './opsAuthenticator.js'
import { OpsError, toOpsError } from './opsError.js'

const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'])

export function createOpsGatewayServer(container: OpsGatewayContainer) {
  const app = new Hono()
  const apiLimiter = new SlidingWindowRateLimiter(180, 60_000)
  const authLimiter = new SlidingWindowRateLimiter(10, 60_000)
  let shuttingDown = false

  app.use('/ops/*', async (c, next) => {
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'same-origin')
    if (shuttingDown && c.req.path !== '/ops/health') {
      return c.json({ detail: 'Ops Gateway 正在关闭，请稍后重试。' }, 503)
    }
    await next()
  })
  app.get('/ops/health', c => c.json({ status: 'ok', component: 'ops-gateway' }))

  app.on(['GET', 'POST'], '/ops/auth/*', async (c, next) => {
    if (!authLimiter.consume(`ops-auth:${clientIp(c.req.raw)}`)) {
      return c.json({ detail: '请求过于频繁，请稍后重试。' }, 429)
    }
    if (c.req.method === 'POST') container.authenticator.requireTrustedRequest(c.req.raw)
    await next()
  }, c => container.auth.handler(c.req.raw))

  app.use('/ops/api/v1/*', async (c, next) => {
    container.authenticator.requireTrustedRequest(c.req.raw)
    if (!apiLimiter.consume(`ops-api:${clientIp(c.req.raw)}`)) {
      throw new OpsError('rate_limited', 429, '请求过于频繁，请稍后重试。')
    }
    await next()
  })

  app.get('/ops/api/v1/bootstrap', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw, true)
    const [host, services] = await Promise.all([
      container.hostMetrics.snapshot(),
      container.processCompose.listServices(),
    ])
    const recovery = principal.recoveryMode ? null : container.authenticator.issueRecovery(principal)
    if (recovery) c.header('set-cookie', recovery.cookie, { append: true })
    return c.json(opsBootstrapSchema.parse({
      user: {
        userId: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
      },
      csrfToken: principal.csrfToken,
      csrfHeaderName: container.environment.CSRF_HEADER_NAME,
      recoveryMode: principal.recoveryMode,
      stepUpExpiresAt: principal.recoveryMode
        ? null
        : container.authenticator.stepUpExpiresAt(c.req.raw, principal),
      terminal: principal.recoveryMode
        ? { available: false, unavailableReason: '数据库恢复模式不允许使用终端。' }
        : container.terminal.availability(),
      host,
      services,
      limits: OPS_LIMITS,
      generatedAt: new Date().toISOString(),
    }))
  })

  app.get('/ops/api/v1/services', async c => {
    await container.authenticator.authenticate(c.req.raw, true)
    return c.json(await container.processCompose.listServices())
  })

  app.get('/ops/api/v1/logs', async c => {
    await container.authenticator.authenticate(c.req.raw)
    const query = parseLogQuery(c.req.query())
    return c.json(await container.processCompose.getLogs(query))
  })

  app.get('/ops/api/v1/logs/export', async c => {
    await container.authenticator.authenticate(c.req.raw)
    const query = parseLogQuery(c.req.query())
    const logs = await container.processCompose.getLogs({ ...query, tail: Math.min(5_000, query.tail) })
    return new Response(`${logs.map(entry => JSON.stringify(entry)).join('\n')}\n`, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="geoforge-operations.ndjson"',
      },
    })
  })

  app.get('/ops/api/v1/terminals', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw)
    return c.json(await container.terminal.list(principal.userId))
  })

  app.get('/ops/api/v1/transcripts', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw)
    return c.json(await container.terminal.listTranscripts(principal.userId))
  })

  app.get('/ops/api/v1/audit', async c => {
    await container.authenticator.authenticate(c.req.raw)
    return c.json(await container.listAuditEvents())
  })

  app.post('/ops/api/v1/step-up', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw)
    container.authenticator.requireCsrf(c.req.raw, principal)
    const body = await parseJson(c.req.raw, opsStepUpRequestSchema)
    const verified = await container.authenticator.verifyPassword(c.req.raw, principal, body.password)
    for (const cookie of verified.authCookies) c.header('set-cookie', cookie, { append: true })
    c.header('set-cookie', verified.cookie, { append: true })
    return c.json(opsStepUpResponseSchema.parse({ verified: true, expiresAt: verified.expiresAt }))
  })

  app.post('/ops/api/v1/transcripts/:terminalId/access', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw)
    container.authenticator.requireCsrf(c.req.raw, principal)
    container.authenticator.requireStepUp(c.req.raw, principal)
    const body = await parseJson(c.req.raw, opsTranscriptAccessRequestSchema)
    return c.json(await container.terminal.grantTranscriptAccess({
      actor: actorFromPrincipal(principal),
      terminalId: c.req.param('terminalId'),
      reason: body.reason,
    }), 201)
  })

  app.get('/ops/api/v1/transcripts/:terminalId/cast', async c => {
    const principal = await container.authenticator.authenticate(c.req.raw)
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline'
    const grantId = c.req.query('grant')
    return container.terminal.createCastResponse({
      actor: actorFromPrincipal(principal),
      terminalId: c.req.param('terminalId'),
      ...(grantId === undefined ? {} : { grantId }),
      disposition,
    })
  })

  app.get('/operations', c => c.redirect('/operations/', 308))
  app.use('/operations/*', async (c, next) => {
    try {
      const auth = await container.auth.authenticateRequest(c.req.raw)
      if (auth && !auth.roles.some(role => role.role === 'platform_admin')) {
        return c.html(forbiddenPage(), 403)
      }
    } catch {
      // 页面壳仍可展示依赖故障；任何数据接口继续遵循硬失败与恢复模式边界。
    }
    await next()
  })
  app.use('/operations/*', serveStatic({
    root: container.environment.staticRoot,
    rewriteRequestPath: requestPath => requestPath.replace(/^\/operations\/?/u, '/'),
  }))
  app.get('/operations/*', serveStatic({
    root: container.environment.staticRoot,
    path: 'index.html',
  }))

  app.onError((error, c) => {
    const mapped = toOpsError(error)
    if (!(error instanceof OpsError)) {
      logger.error({ error: errorLogPayload(error), path: c.req.path }, 'operations request failed')
    }
    return c.json({ detail: mapped.publicMessage }, mapped.status)
  })
  app.notFound(c => c.json({ detail: '运维资源不存在。' }, 404))

  const server = createServer(getRequestListener(app.fetch))
  const controlWsServer = new WebSocketServer({ noServer: true, maxPayload: OPS_LIMITS.maximumFrameBytes })
  const terminalWsServer = new WebSocketServer({ noServer: true, maxPayload: OPS_LIMITS.maximumFrameBytes })
  const terminalWriters = new Map<string, WebSocket>()

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade({
      request,
      container,
      controlWsServer,
      terminalWsServer,
      terminalWriters,
      socket,
      head,
    }).catch(error => {
      logger.warn({ error: errorLogPayload(error) }, 'operations websocket upgrade rejected')
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })
  })

  return {
    app,
    server,
    controlWsServer,
    terminalWsServer,
    startShutdown: () => { shuttingDown = true },
  }
}

async function handleUpgrade(input: {
  request: IncomingMessage
  container: OpsGatewayContainer
  controlWsServer: WebSocketServer
  terminalWsServer: WebSocketServer
  terminalWriters: Map<string, WebSocket>
  socket: import('node:stream').Duplex
  head: Buffer
}): Promise<void> {
  const url = new URL(input.request.url ?? '/', input.container.environment.OPS_PUBLIC_BASE_URL)
  const request = requestFromUpgrade(input.request, url)
  input.container.authenticator.requireTrustedRequest(request)
  if (url.pathname === '/ops/ws') {
    const principal = await input.container.authenticator.authenticate(request, true)
    input.controlWsServer.handleUpgrade(input.request, input.socket, input.head, client => {
      handleControlConnection(client, request, principal, input.container)
    })
    return
  }
  const match = /^\/ops\/terminal\/([^/]+)$/u.exec(url.pathname)
  const terminalId = match?.[1] ? decodeURIComponent(match[1]) : null
  if (!terminalId) throw new OpsError('not_found', 404, 'WebSocket 端点不存在。')
  const principal = await input.container.authenticator.authenticate(request)
  input.terminalWsServer.handleUpgrade(input.request, input.socket, input.head, client => {
    handleTerminalConnection({
      client,
      request,
      principal,
      terminalId,
      container: input.container,
      terminalWriters: input.terminalWriters,
    })
  })
}

function handleControlConnection(
  socket: WebSocket,
  request: Request,
  principal: OpsPrincipal,
  container: OpsGatewayContainer,
): void {
  const connectionId = crypto.randomUUID()
  const limiter = new WsMessageRateLimiter(120, 60_000, 40)
  let metricsTimer: NodeJS.Timeout | null = null
  let metricsSubscribed = false
  let logSubscription: { close(): void } | null = null

  const scheduleMetrics = () => {
    if (!metricsSubscribed || socket.readyState !== 1) return
    metricsTimer = setTimeout(() => {
      void sendMetricSnapshot(socket, container).finally(scheduleMetrics)
    }, 2_000)
  }

  socket.on('message', data => {
    void (async () => {
      let value: unknown
      try {
        value = JSON.parse(data.toString()) as unknown
      } catch {
        sendControlError(socket, 'unknown', 'invalid_request', '控制命令不是有效 JSON。')
        return
      }
      const parsed = opsControlCommandSchema.safeParse(value)
      if (!parsed.success) {
        sendControlError(socket, requestIdFrom(value), 'invalid_request', '控制命令格式无效。')
        return
      }
      const command = parsed.data
      if (command.csrfToken !== principal.csrfToken) {
        sendControlError(socket, command.requestId, 'forbidden', 'CSRF 校验失败。')
        return
      }
      if (!limiter.consume(connectionId, command.type)) {
        sendControlError(socket, command.requestId, 'rate_limited', '控制命令过于频繁，请稍后重试。')
        return
      }
      try {
        if (command.type === 'subscribe_metrics') {
          if (!metricsSubscribed) {
            metricsSubscribed = true
            await sendMetricSnapshot(socket, container)
            scheduleMetrics()
          }
          sendControlSuccess(socket, command.requestId, { subscribed: true })
          return
        }
        if (command.type === 'subscribe_logs') {
          logSubscription?.close()
          for (const entry of await container.processCompose.getLogs(command)) {
            sendPush(socket, { type: 'log_entry', payload: entry })
          }
          logSubscription = container.processCompose.subscribeLogs({
            ...command,
            onEntry: entry => sendPush(socket, { type: 'log_entry', payload: entry }),
            onError: message => sendControlError(socket, command.requestId, 'dependency_unavailable', message),
          })
          sendControlSuccess(socket, command.requestId, { subscribed: true })
          return
        }
        if (command.type === 'service_action') {
          const snapshot = await executeServiceAction(command, request, principal, container)
          sendControlSuccess(socket, command.requestId, snapshot)
          sendPush(socket, { type: 'service_snapshot', payload: await container.processCompose.listServices() })
          return
        }
        if (principal.recoveryMode) {
          throw new OpsError('forbidden', 403, '数据库恢复模式只允许恢复基础设施。')
        }
        if (command.type === 'terminal_list') {
          sendControlSuccess(socket, command.requestId, await container.terminal.list(principal.userId))
          return
        }
        container.authenticator.requireStepUp(request, principal)
        if (command.type === 'terminal_create') {
          const terminal = await container.terminal.create({
            actor: actorFromPrincipal(principal),
            label: command.label,
            cols: command.cols,
            rows: command.rows,
          })
          sendControlSuccess(socket, command.requestId, terminal)
          sendPush(socket, { type: 'terminal_snapshot', payload: terminal })
          return
        }
        const terminal = await container.terminal.terminate(actorFromPrincipal(principal), command.terminalId)
        sendControlSuccess(socket, command.requestId, terminal)
        sendPush(socket, { type: 'terminal_snapshot', payload: terminal })
      } catch (error) {
        const mapped = error instanceof OpsError
          ? error
          : new OpsError('dependency_unavailable', 503, safeDependencyMessage(error))
        sendControlError(socket, command.requestId, mapped.code, mapped.publicMessage)
      }
    })()
  })
  socket.on('close', () => {
    metricsSubscribed = false
    if (metricsTimer) clearTimeout(metricsTimer)
    logSubscription?.close()
  })
}

async function executeServiceAction(
  command: Extract<OpsControlCommand, { type: 'service_action' }>,
  request: Request,
  principal: OpsPrincipal,
  container: OpsGatewayContainer,
) {
  if (principal.recoveryMode) {
    if (command.serviceId !== 'infra' || !['start', 'restart'].includes(command.action)) {
      await recordServiceAudit(container, principal, command, 'denied')
      throw new OpsError('forbidden', 403, '恢复模式仅允许启动或重启 infra。')
    }
  } else {
    container.authenticator.requireStepUp(request, principal)
  }
  if (['stop', 'restart'].includes(command.action)) {
    const expected = command.serviceId === 'infra' ? 'infra' : 'confirmed'
    if (command.confirmation !== expected) {
      await recordServiceAudit(container, principal, command, 'denied')
      throw new OpsError('invalid_request', 400, command.serviceId === 'infra'
        ? '停止或重启基础设施必须输入 infra。'
        : '请先确认服务中断影响。')
    }
  }
  try {
    const snapshot = await container.processCompose.performAction(command.serviceId, command.action)
    await recordServiceAudit(container, principal, command, 'allowed')
    return snapshot
  } catch (error) {
    await recordServiceAudit(container, principal, command, 'error')
    throw error
  }
}

function handleTerminalConnection(input: {
  client: WebSocket
  request: Request
  principal: OpsPrincipal
  terminalId: string
  container: OpsGatewayContainer
  terminalWriters: Map<string, WebSocket>
}): void {
  let broker: WebSocket | null = null
  let authenticated = false
  let closed = false
  const authTimer = setTimeout(() => input.client.close(1008, '终端认证超时'), 10_000)

  input.client.on('message', (data, isBinary) => {
    void (async () => {
      if (!authenticated) {
        if (isBinary) throw new OpsError('invalid_request', 400, '终端首帧必须是认证控制帧。')
        const control = opsTerminalClientControlSchema.parse(JSON.parse(data.toString()) as unknown)
        if (control.type !== 'auth' || control.csrfToken !== input.principal.csrfToken) {
          throw new OpsError('forbidden', 403, '终端认证或 CSRF 校验失败。')
        }
        input.container.authenticator.requireStepUp(input.request, input.principal)
        const terminal = await input.container.terminal.requireOwnedSession(input.principal.userId, input.terminalId)
        broker = input.container.terminal.openBrokerTerminal(input.terminalId)
        broker.once('open', () => {
          if (closed) {
            broker?.close()
            return
          }
          const previous = input.terminalWriters.get(input.terminalId)
          if (previous && previous !== input.client) previous.close(4001, '终端已由新的连接接管')
          input.terminalWriters.set(input.terminalId, input.client)
          authenticated = true
          clearTimeout(authTimer)
          sendTerminalControl(input.client, { type: 'ready', terminal })
          void input.container.audit.recordEvent({
            actorUserId: input.principal.userId,
            workspaceId: null,
            action: 'ops.terminal.attach',
            objectType: 'operations_terminal',
            objectId: input.terminalId,
            outcome: 'allowed',
            metadata: {},
          })
        })
        broker.on('message', (brokerData, brokerBinary) => {
          if (brokerBinary) {
            if (input.client.readyState === 1) input.client.send(rawDataBytes(brokerData), { binary: true })
            return
          }
          void forwardBrokerControl(brokerData, input).catch(() => {
            input.client.close(1011, '终端状态同步失败')
          })
        })
        broker.on('error', () => {
          sendTerminalControl(input.client, { type: 'error', message: 'Terminal Broker 连接失败。' })
          input.client.close(1011, 'Terminal Broker 连接失败')
        })
        broker.on('close', (code, reason) => {
          if (input.client.readyState !== 1) return
          const clean = code === 1000
          input.client.close(clean ? 1000 : 1011, reason.toString() || (clean ? '终端进程已退出' : 'Terminal Broker 连接已关闭'))
        })
        return
      }
      if (!broker || broker.readyState !== 1) throw new OpsError('conflict', 409, '终端尚未连接。')
      if (isBinary) {
        broker.send(rawDataBytes(data), { binary: true })
        return
      }
      const control = opsTerminalClientControlSchema.parse(JSON.parse(data.toString()) as unknown)
      if (control.type === 'auth') throw new OpsError('invalid_request', 400, '终端已经完成认证。')
      broker.send(JSON.stringify(control))
    })().catch(error => {
      const mapped = error instanceof OpsError ? error : new OpsError('invalid_request', 400, '终端输入或控制帧无效。')
      sendTerminalControl(input.client, { type: 'error', message: mapped.publicMessage })
      input.client.close(1008, mapped.publicMessage)
    })
  })

  input.client.on('close', () => {
    closed = true
    clearTimeout(authTimer)
    if (input.terminalWriters.get(input.terminalId) === input.client) {
      input.terminalWriters.delete(input.terminalId)
    }
    if (broker?.readyState === 1) broker.send(JSON.stringify({ type: 'detach' }))
    broker?.close()
    if (authenticated) {
      void input.container.audit.recordEvent({
        actorUserId: input.principal.userId,
        workspaceId: null,
        action: 'ops.terminal.detach',
        objectType: 'operations_terminal',
        objectId: input.terminalId,
        outcome: 'allowed',
        metadata: {},
      })
    }
  })
}

async function forwardBrokerControl(
  raw: RawData,
  input: {
    client: WebSocket
    terminalId: string
    container: OpsGatewayContainer
  },
): Promise<void> {
  const parsed = brokerTerminalServerMessageSchema.parse(JSON.parse(raw.toString()) as unknown)
  if (parsed.type === 'screen') {
    sendTerminalControl(input.client, parsed)
    return
  }
  if (parsed.type === 'error') {
    sendTerminalControl(input.client, parsed)
    return
  }
  const terminal = await input.container.terminal.ingestBrokerSnapshot(parsed.terminal)
  sendTerminalControl(input.client, { type: 'state', terminal })
}

async function sendMetricSnapshot(socket: WebSocket, container: OpsGatewayContainer): Promise<void> {
  if (socket.readyState !== 1) return
  try {
    const [host, services] = await Promise.all([
      container.hostMetrics.snapshot(),
      container.processCompose.listServices(),
    ])
    sendPush(socket, { type: 'host_snapshot', payload: host })
    sendPush(socket, { type: 'service_snapshot', payload: services })
  } catch {
    sendControlError(socket, 'metrics', 'dependency_unavailable', '主机指标或服务状态暂时不可用。')
  }
}

function sendPush(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(opsPushEventSchema.parse(value)))
}

function sendControlSuccess(socket: WebSocket, requestId: string, data: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify({ requestId, ok: true, data }))
}

function sendControlError(
  socket: WebSocket,
  requestId: string,
  code: 'invalid_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'dependency_unavailable' | 'command_failed',
  message: string,
): void {
  if (socket.readyState === 1) socket.send(JSON.stringify({ requestId, ok: false, error: { code, message } }))
}

function sendTerminalControl(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(opsTerminalServerControlSchema.parse(value)))
}

function parseLogQuery(query: Record<string, string>): {
  services: OpsServiceId[]
  levels: OpsLogLevel[]
  search: string
  tail: number
} {
  const services = z.array(opsServiceIdSchema).min(1).max(4).parse(
    (query.services ?? 'api').split(',').filter(Boolean),
  )
  const levels = z.array(logLevelSchema).max(7).parse(
    (query.levels ?? '').split(',').filter(Boolean),
  )
  return {
    services,
    levels,
    search: z.string().max(200).parse(query.search ?? ''),
    tail: z.coerce.number().int().min(1).max(5_000).parse(query.tail ?? '500'),
  }
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new OpsError('invalid_request', 400, '请求正文不是有效 JSON。')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new OpsError('invalid_request', 400, parsed.error.issues[0]?.message ?? '请求参数无效。')
  }
  return parsed.data
}

function requestFromUpgrade(request: IncomingMessage, url: URL): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  return new Request(url, { method: 'GET', headers })
}

function actorFromPrincipal(principal: OpsPrincipal) {
  return { userId: principal.userId, displayName: principal.displayName }
}

function requestIdFrom(value: unknown): string {
  if (value && typeof value === 'object' && 'requestId' in value
    && typeof (value as { requestId?: unknown }).requestId === 'string') {
    return (value as { requestId: string }).requestId.slice(0, 128)
  }
  return 'unknown'
}

function rawDataBytes(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function safeDependencyMessage(error: unknown): string {
  if (error instanceof Error && /^(Process Compose|Terminal Broker|主机|终端)/u.test(error.message)) {
    return error.message
  }
  return '运维依赖当前不可用，请查看 Ops Gateway 服务端日志。'
}

function recordServiceAudit(
  container: OpsGatewayContainer,
  principal: OpsPrincipal,
  command: Extract<OpsControlCommand, { type: 'service_action' }>,
  outcome: 'allowed' | 'denied' | 'error',
): Promise<void> {
  return container.audit.recordEvent({
    actorUserId: principal.userId,
    workspaceId: null,
    action: `ops.service.${opsServiceActionSchema.parse(command.action)}`,
    objectType: 'operations_service',
    objectId: command.serviceId,
    outcome,
    metadata: {
      recoveryMode: principal.recoveryMode,
      dependencies: OPS_SERVICE_METADATA[command.serviceId].dependencies,
    },
  })
}

function forbiddenPage(): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>禁止访问</title><body style="font:14px system-ui;margin:64px;color:#20262e"><h1 style="font-size:22px">无权访问运维后台</h1><p>仅平台管理员可以访问此页面。</p></body></html>'
}
