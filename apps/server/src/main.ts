// +-------------------------------------------------------------------------
//
//   地理智能平台 - Node API 与 WebSocket 服务入口
//
//   文件:       main.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 workspaces 子目录启动时，dotenv 需要指向项目根目录的 .env
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
dotenv.config({ path: path.join(projectRoot, '.env') })

import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { metricsResponse, observeHttpMetrics } from './observability/metrics.js'
import { errorLogPayload, logger, logHttpRequestSummary, traceId, withLogContext } from './observability/logger.js'
import { LocalAgentTracing } from './observability/agentTracing.js'
import { getEnv } from './framework/env.js'
import { artifactRoutes } from './routes/artifacts.js'
import { fileRoutes } from './routes/files.js'
import { layerRoutes } from './routes/layers.js'
import { mapRoutes } from './routes/map.js'
import { meteorologyRoutes } from './routes/meteorology.js'
import { shareRoutes } from './routes/share.js'
import { createWsHandler } from './ws/handler.js'
import { AuthorizationError } from './security/authorizationService.js'
import { requireHttpAuth, securityRoutes } from './security/routes.js'
import {
  authRateLimitMiddleware,
  apiRateLimitMiddleware,
} from './security/httpRateLimit.js'
import { installLifecycleManager } from './lifecycle.js'
import { createAppContainer } from './app/container.js'

const env = getEnv()
// SDK tracing 使用进程级 provider。这里只安装本地结构化处理器，不注册
// OpenAI exporter，也不记录模型正文或工具输入输出。
const agentTracing = new LocalAgentTracing()
agentTracing.install()
const container = await createAppContainer({ env, projectRoot, agentTracing })

const app = new Hono()
const trustedOrigins = new Set([
  ...container.security.auth.trustedOrigins(),
  env.APP_BASE_URL.replace(/\/+$/u, ''),
  ...(env.WEB_BASE_URL ? [env.WEB_BASE_URL.replace(/\/+$/u, '')] : []),
])
let isShuttingDown = false
app.use('*', cors({
  origin: origin => origin && trustedOrigins.has(origin.replace(/\/+$/u, '')) ? origin : '',
  credentials: true,
  allowHeaders: ['Content-Type', env.CSRF_HEADER_NAME],
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}))
app.use('*', async (c, next) => {
  const requestTraceId = traceId()
  const pathname = new URL(c.req.url).pathname
  c.header('x-geoforge-trace-id', requestTraceId)
  const started = performance.now()
  await withLogContext({
    traceId: requestTraceId,
    httpMethod: c.req.method,
    httpPath: pathname,
  }, async () => {
    try {
      await next()
    } finally {
      const auth = (c as { get(key: string): unknown }).get('auth')
      logHttpRequestSummary({
        traceId: requestTraceId,
        method: c.req.method,
        path: pathname,
        statusCode: c.res.status || 200,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        userId: auth && typeof auth === 'object' && 'userId' in auth ? String(auth.userId) : undefined,
      })
    }
  })
})
app.use('*', observeHttpMetrics)
app.use('*', async (c, next) => {
  if (isShuttingDown && c.req.path !== '/health' && c.req.path !== '/metrics') return c.json({ detail: '服务正在关闭，请稍后重试。' }, 503)
  await next()
})
app.get('/health', async c => {
  const health = await container.checkReadiness()
  return c.json(health, health.status === 'ok' ? 200 : 503)
})
app.get('/metrics', async () => {
  return metricsResponse()
})
app.use('/api/share/*', apiRateLimitMiddleware(container.security))
app.route('/', shareRoutes(container.store))
app.on(['GET', 'POST'], '/api/auth/*', authRateLimitMiddleware, c => container.security.auth.handler(c.req.raw))
app.use('/api/v1/*', apiRateLimitMiddleware(container.security), (c, next) => requireHttpAuth(container.security, c, next))
app.route('/', securityRoutes(container.security))
app.route('/', fileRoutes(container.runtimeRoot, container.store, container.security, env))
app.route('/', layerRoutes(container.managedLayers, container.store, container.security, env))
app.route('/', artifactRoutes(container.artifactRepository, container.runtimeRoot, container.security))
app.route('/', mapRoutes({
  mapStore: container.mapStore,
  tileGateway: container.mapTileGateway,
  security: container.security,
  publicShareStore: container.store,
  runtimeRoot: container.runtimeRoot,
}))
app.route('/', meteorologyRoutes(container.runtimeRoot, container.store, container.security, env))
app.onError((error, c) => {
  if (error instanceof AuthorizationError) return c.json({ detail: error.message }, 403)
  if (error.message === '未登录。') return c.json({ detail: '未登录' }, 401)
  logger.error({ error: errorLogPayload(error), path: c.req.path, method: c.req.method }, 'request failed')
  return c.json({ detail: '服务处理失败。请查看服务端日志。' }, 500)
})
app.notFound(c => c.json({ detail: 'Not found' }, 404))

const server = createServer(getRequestListener(app.fetch))
const wsServer = createWsHandler(server, {
  env,
  store: container.store,
  toolRegistry: container.toolRegistry,
  modelRegistry: container.modelRegistry,
  modelCompletions: container.modelCompletions,
  managedLayers: container.managedLayers,
  runtimeRoot: container.runtimeRoot,
  defaultRuntimeConfig: container.defaultRuntimeConfig,
  runtime: container.runtime,
  runTasks: container.runTasks,
  scheduledTaskService: container.scheduledTaskService,
  automationDefinitionService: container.automationDefinitionService,
  backgroundTasks: container.backgroundTasks,
  usageStats: container.usageStats,
  mapStore: container.mapStore,
  security: container.security,
})
installLifecycleManager({
  server,
  wsServer,
  store: container.store,
  db: container.db,
  instanceLock: container.instanceLock,
  onShutdownStart: () => { isShuttingDown = true },
  beforeDrain: () => container.shutdown(),
})

server.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'server listening')
  logger.info({ tools: container.toolRegistry.list().length, providers: container.toolRegistry.listProviders().length }, 'tool providers loaded')
})
