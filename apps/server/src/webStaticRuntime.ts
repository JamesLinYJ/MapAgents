// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 主工作台静态文件服务
//
//   文件:       webStaticRuntime.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { z } from 'zod'

import { installStandaloneLifecycleManager } from './lifecycle.js'
import { errorLogPayload, logger } from './observability/logger.js'

const environmentSchema = z.object({
  WEB_STATIC_HOST: z.string().min(1).default('127.0.0.1'),
  WEB_STATIC_PORT: z.coerce.number().int().min(1).max(65_535).default(5173),
  WEB_STATIC_ROOT: z.string().min(1).default('apps/web/dist'),
}).passthrough()

async function start(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const environment = environmentSchema.parse(process.env)
  const staticRoot = path.isAbsolute(environment.WEB_STATIC_ROOT)
    ? environment.WEB_STATIC_ROOT
    : path.resolve(projectRoot, environment.WEB_STATIC_ROOT)
  const app = new Hono()
  app.get('/health', c => c.json({ status: 'ok', component: 'web-static' }))
  app.use('*', serveStatic({ root: staticRoot }))
  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }))
  const server = createServer(getRequestListener(app.fetch))
  installStandaloneLifecycleManager({
    component: 'web-static',
    drain: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  })
  server.listen(environment.WEB_STATIC_PORT, environment.WEB_STATIC_HOST, () => {
    logger.info({ host: environment.WEB_STATIC_HOST, port: environment.WEB_STATIC_PORT }, 'web static server listening')
  })
}

start().catch(error => {
  logger.fatal({ error: errorLogPayload(error) }, 'web static server startup failed')
  process.exit(1)
})
