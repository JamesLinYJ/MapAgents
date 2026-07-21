// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Ops Gateway 进程入口
//
//   文件:       opsGatewayRuntime.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installStandaloneLifecycleManager } from '../lifecycle.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { parseOpsGatewayEnvironment } from './config.js'
import { createOpsGatewayContainer } from './opsGatewayContainer.js'
import { createOpsGatewayServer } from './opsGatewayServer.js'

async function startOpsGateway(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  dotenv.config({ path: path.join(projectRoot, '.env') })
  const environment = parseOpsGatewayEnvironment(process.env, projectRoot)
  const container = await createOpsGatewayContainer({ environment })
  const gateway = createOpsGatewayServer(container)
  installStandaloneLifecycleManager({
    component: 'ops-gateway',
    onShutdownStart: gateway.startShutdown,
    drain: async () => {
      for (const client of gateway.controlWsServer.clients) client.close(1001, 'gateway shutting down')
      for (const client of gateway.terminalWsServer.clients) client.close(1001, 'gateway shutting down')
      await Promise.all([
        new Promise<void>((resolve, reject) => gateway.server.close(error => error ? reject(error) : resolve())),
        new Promise<void>(resolve => gateway.controlWsServer.close(() => resolve())),
        new Promise<void>(resolve => gateway.terminalWsServer.close(() => resolve())),
      ])
      await container.shutdown()
    },
  })
  gateway.server.listen(environment.OPS_GATEWAY_PORT, environment.OPS_GATEWAY_HOST, () => {
    logger.info({
      component: 'ops-gateway',
      host: environment.OPS_GATEWAY_HOST,
      port: environment.OPS_GATEWAY_PORT,
    }, 'ops gateway listening')
  })
}

startOpsGateway().catch(error => {
  logger.fatal({ component: 'ops-gateway', error: errorLogPayload(error) }, 'ops gateway startup failed')
  process.exit(1)
})
