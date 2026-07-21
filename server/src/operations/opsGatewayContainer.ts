// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Ops Gateway 依赖装配
//
//   文件:       opsGatewayContainer.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import { access } from 'node:fs/promises'
import path from 'node:path'

import { createDb, type Database } from '../db/connection.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { BetterAuthService } from '../security/authService.js'
import { ensureSecurityTables } from '../security/database.js'
import { PlatformIdentityService } from '../security/platformIdentityService.js'
import { AuditStore } from '../store/postgres/auditStore.js'
import { AuthSessionRepository } from '../store/postgres/authSessionRepository.js'
import { MembershipRepository } from '../store/postgres/membershipRepository.js'
import { PostgresObjectReferenceRepository } from '../store/postgres/objectReferenceRepository.js'
import { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import type { OpsGatewayEnvironment } from './config.js'
import { ensureOperationsTables } from './database.js'
import { HostMetricsService } from './hostMetricsService.js'
import { OpsAuditService } from './opsAuditService.js'
import { OpsAuthenticator } from './opsAuthenticator.js'
import { TerminalKeyring } from './keyring.js'
import { ProcessComposeClient } from './processComposeClient.js'
import { TerminalBrokerClient } from './terminalBrokerClient.js'
import { TerminalRepository } from './terminalRepository.js'
import { TerminalService } from './terminalService.js'

export interface OpsGatewayContainer {
  environment: OpsGatewayEnvironment
  db: Database
  auth: BetterAuthService
  authenticator: OpsAuthenticator
  audit: OpsAuditService
  processCompose: ProcessComposeClient
  hostMetrics: HostMetricsService
  terminal: TerminalService
  listAuditEvents(): Promise<AuditEvent[]>
  shutdown(): Promise<void>
}

export async function createOpsGatewayContainer(input: {
  environment: OpsGatewayEnvironment
}): Promise<OpsGatewayContainer> {
  const { environment } = input
  const db = createDb(environment.DATABASE_URL)
  const timers: NodeJS.Timeout[] = []
  try {
    await ensureSecurityTables(db)
    await ensureOperationsTables(db)
    await access(path.join(environment.staticRoot, 'index.html')).catch(() => {
      throw new Error('运维静态页面尚未构建，Ops Gateway 已拒绝启动。')
    })
    const users = new PlatformUserRepository(db)
    const identity = new PlatformIdentityService({
      db,
      users,
      workspaces: new WorkspaceRepository(db),
      memberships: new MembershipRepository(db),
      authSessions: new AuthSessionRepository(db),
    })
    const auditStore = new AuditStore(db)
    const audit = new OpsAuditService(auditStore)
    const auth = new BetterAuthService({
      db,
      identity,
      basePath: '/ops/auth',
      env: {
        APP_BASE_URL: environment.OPS_PUBLIC_BASE_URL,
        BETTER_AUTH_URL: environment.OPS_PUBLIC_BASE_URL,
        BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
        BETTER_AUTH_ALLOW_SIGN_UP: environment.BETTER_AUTH_ALLOW_SIGN_UP,
        BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: environment.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION,
        BETTER_AUTH_MIN_PASSWORD_LENGTH: environment.BETTER_AUTH_MIN_PASSWORD_LENGTH,
        BOOTSTRAP_ADMIN_EMAIL: environment.BOOTSTRAP_ADMIN_EMAIL,
        TRUSTED_ORIGINS: [...environment.trustedOrigins].join(','),
        CSRF_HEADER_NAME: environment.CSRF_HEADER_NAME,
      },
    })
    const authenticator = new OpsAuthenticator({
      auth,
      audit,
      recoverySecret: environment.OPS_RECOVERY_SECRET,
      secureCookies: new URL(environment.OPS_PUBLIC_BASE_URL).protocol === 'https:',
      trustedOrigins: environment.trustedOrigins,
      csrfHeaderName: environment.CSRF_HEADER_NAME,
    })
    const processCompose = new ProcessComposeClient(
      environment.PROCESS_COMPOSE_URL,
      environment.processComposeTokenFile,
    )
    await processCompose.initialize()
    const keyring = await TerminalKeyring.load(environment.keyringFile, environment.OPS_ACTIVE_KEY_ID)
    const terminal = new TerminalService({
      runtimeRoot: environment.runtimeRoot,
      repository: new TerminalRepository(db),
      broker: new TerminalBrokerClient(environment.OPS_BROKER_URL, environment.OPS_BROKER_SHARED_SECRET),
      keyring,
      audit,
      objectReferences: new PostgresObjectReferenceRepository(db),
    })
    await terminal.initialize()
    await terminal.rewrapRetainedDataKeys()

    let maintenanceRunning = false
    const maintenanceTimer = setInterval(() => {
      if (maintenanceRunning) return
      maintenanceRunning = true
      void Promise.all([
        terminal.availability().available ? terminal.drainBrokerSpool() : terminal.initialize(),
        audit.flush(),
      ]).catch(error => {
        logger.warn({ error: errorLogPayload(error) }, 'operations maintenance pass failed')
      }).finally(() => { maintenanceRunning = false })
    }, 2_000)
    maintenanceTimer.unref()
    timers.push(maintenanceTimer)

    let retentionRunning = false
    const retentionTimer = setInterval(() => {
      if (retentionRunning) return
      retentionRunning = true
      void terminal.cleanupExpiredTranscripts().catch(error => {
        logger.error({ error: errorLogPayload(error) }, 'operations transcript retention failed')
      }).finally(() => { retentionRunning = false })
    }, 60 * 60 * 1_000)
    retentionTimer.unref()
    timers.push(retentionTimer)

    return {
      environment,
      db,
      auth,
      authenticator,
      audit,
      processCompose,
      hostMetrics: new HostMetricsService(),
      terminal,
      listAuditEvents: async () => (await auditStore.listRecent(1_000))
        .filter(event => event.action.startsWith('ops.')),
      shutdown: async () => {
        for (const timer of timers) clearInterval(timer)
        await terminal.drainBrokerSpool().catch(() => undefined)
        await audit.flush()
        await db.close()
      },
    }
  } catch (error) {
    for (const timer of timers) clearInterval(timer)
    await db.close().catch(() => undefined)
    throw error
  }
}
