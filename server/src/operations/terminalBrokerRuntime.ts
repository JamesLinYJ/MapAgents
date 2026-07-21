// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker 进程装配
//
//   文件:       terminalBrokerRuntime.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { installStandaloneLifecycleManager } from '../lifecycle.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { parseTerminalBrokerEnvironment } from './config.js'
import { TerminalManager } from './terminalManager.js'
import { createTerminalBrokerServer } from './terminalBrokerServer.js'
import { TranscriptSpool } from './transcriptSpool.js'

export async function startTerminalBroker(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const environment = parseTerminalBrokerEnvironment(process.env, projectRoot)
  const spool = new TranscriptSpool(environment.spoolRoot)
  const manager = new TerminalManager(environment, spool)
  await manager.initialize()
  const { server, wsServer } = createTerminalBrokerServer({ environment, manager, spool })
  installStandaloneLifecycleManager({
    component: 'terminal-broker',
    drain: async () => {
      for (const client of wsServer.clients) client.close(1001, 'broker shutting down')
      await manager.shutdown()
      await Promise.all([
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        new Promise<void>(resolve => wsServer.close(() => resolve())),
      ])
    },
  })
  server.listen(environment.OPS_BROKER_PORT, environment.OPS_BROKER_HOST, () => {
    logger.info({
      component: 'terminal-broker',
      host: environment.OPS_BROKER_HOST,
      port: environment.OPS_BROKER_PORT,
    }, 'terminal broker listening')
  })
}

startTerminalBroker().catch(error => {
  logger.fatal({ component: 'terminal-broker', error: errorLogPayload(error) }, 'terminal broker startup failed')
  process.exit(1)
})
