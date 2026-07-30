// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机运维特权进程边界
//
//   文件:       localOperationsBrokerEntry.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  localOperationsRequestSchema,
  type LocalOperationsRequest,
} from '@geo-agent-platform/shared-types/local-operations'
import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
} from '@geo-agent-platform/operations-supervisor'
import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { config as loadDotEnv } from 'dotenv'

import { createDb } from '../db/connection.js'
import { verifyDatabaseSchemaCompatibility } from '../db/schemaCompatibility.js'
import { parseEnv } from '../framework/env.js'
import { BetterAuthService } from '../security/authService.js'
import { ensureSecurityTables } from '../security/database.js'
import { deriveLocalConsoleCredential } from '../security/localConsolePrincipal.js'
import { PlatformIdentityService } from '../security/platformIdentityService.js'
import { AuditStore } from '../store/postgres/auditStore.js'
import { AuthSessionRepository } from '../store/postgres/authSessionRepository.js'
import { LocalAccountRepository } from '../store/postgres/localAccountRepository.js'
import { MembershipRepository } from '../store/postgres/membershipRepository.js'
import { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import { LocalAccountService } from './localAccountService.js'

type BrokerMode = 'accounts' | 'agent'

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  const env = parseEnv(process.env)
  const profile: OperationsProfile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile,
    ...(process.env.RUNTIME_ROOT ? { runtimeRoot: path.resolve(projectRoot, process.env.RUNTIME_ROOT) } : {}),
    ...(process.env.GEOFORGE_LOCAL_ROOT_SECRET_FILE
      ? { rootSecretFile: path.resolve(projectRoot, process.env.GEOFORGE_LOCAL_ROOT_SECRET_FILE) }
      : {}),
  })
  const rootSecret = await ensureSecretFile(paths.rootSecretFile, profile === 'development')
  if (profile === 'production') await assertProductionSecretPermissions(paths.rootSecretFile)

  const db = createDb(env.DATABASE_URL)
  try {
    await verifyDatabaseSchemaCompatibility(db)
    await ensureSecurityTables(db)
    const users = new PlatformUserRepository(db)
    const memberships = new MembershipRepository(db)
    const workspaces = new WorkspaceRepository(db)
    const identity = new PlatformIdentityService({
      db,
      users,
      workspaces,
      memberships,
      authSessions: new AuthSessionRepository(db),
    })
    const auth = new BetterAuthService({ db, env, identity })
    const audit = new AuditStore(db)
    if (mode === 'accounts') {
      const credential = deriveLocalConsoleCredential(rootSecret)
      await serveAccountRequests(new LocalAccountService({
        db,
        auth,
        identity,
        accounts: new LocalAccountRepository(db),
        users,
        workspaces,
        memberships,
        audit,
        actor: localActor(),
        rootSecret,
        rootKeyVersion: credential.keyVersion,
        minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
      }), audit)
      return
    }
    await serveAgentAuthorization({
      auth,
      audit,
      rootSecret,
      appBaseUrl: localApiEndpoint(env.API_PORT),
      origin: new URL(env.APP_BASE_URL).origin,
    })
  } finally {
    await db.close()
  }
}

async function serveAccountRequests(
  accounts: LocalAccountService,
  audit: AuditStore,
): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    let requestId = 'invalid'
    try {
      const request = localOperationsRequestSchema.parse(JSON.parse(line))
      requestId = request.id
      const result = await executeAccountRequest(request, accounts, audit)
      writeResponse({ id: request.id, ok: true, result })
    } catch (error) {
      writeResponse({ id: requestId, ok: false, error: errorMessage(error) })
    }
  }
}

async function executeAccountRequest(
  request: LocalOperationsRequest,
  accounts: LocalAccountService,
  audit: AuditStore,
): Promise<unknown> {
  switch (request.operation) {
    case 'accounts.list':
      return accounts.listAccounts()
    case 'accounts.createPlatformAdmin':
      return accounts.createPlatformAdmin(request.input)
    case 'accounts.grantPlatformAdmin':
      return accounts.grantPlatformAdmin(request.email)
    case 'accounts.revokePlatformAdmin':
      return accounts.revokePlatformAdmin(request.email)
    case 'accounts.setEnabled':
      return accounts.setAccountEnabled(request.email, request.enabled)
    case 'accounts.resetPassword':
      await accounts.resetPassword(request.email, request.password)
      return null
    case 'accounts.revokeSessions':
      await accounts.revokeSessions(request.email)
      return null
    case 'audit.list':
      return audit.listRecent(request.limit)
    case 'agent.close':
      throw new Error('账户 Broker 不接受 Agent 关闭命令。')
  }
}

async function serveAgentAuthorization(input: {
  auth: BetterAuthService
  audit: AuditStore
  rootSecret: string
  appBaseUrl: string
  origin: string
}): Promise<void> {
  await input.auth.withLocalAgentAuthorization(input.rootSecret, async authorization => {
    const actor = {
      ...localActor(),
      keyVersion: authorization.keyVersion,
      transport: 'loopback_websocket',
    }
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_agent.session.open',
      objectType: 'system',
      objectId: null,
      outcome: 'allowed',
      metadata: actor,
    })
    const cookie = authorization.headers.get('cookie')
    if (!cookie) throw new Error('本机 Agent 授权未生成 Cookie。')
    process.stdout.write(`${JSON.stringify({
      type: 'agent.authorization',
      appBaseUrl: input.appBaseUrl,
      origin: input.origin,
      cookie,
      csrfToken: authorization.authContext.csrfToken,
      actor,
    })}\n`)

    let closeRequest: Extract<LocalOperationsRequest, { operation: 'agent.close' }> | null = null
    const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (!line.trim()) continue
      const request = localOperationsRequestSchema.parse(JSON.parse(line))
      if (request.operation !== 'agent.close') {
        writeResponse({ id: request.id, ok: false, error: 'Agent Broker 只接受关闭命令。' })
        continue
      }
      closeRequest = request
      writeResponse({ id: request.id, ok: true, result: null })
      break
    }
    const outcome = closeRequest?.outcome ?? 'error'
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_agent.session.close',
      objectType: 'system',
      objectId: closeRequest?.runId ?? null,
      outcome,
      metadata: {
        ...actor,
        threadId: closeRequest?.threadId ?? null,
        runId: closeRequest?.runId ?? null,
      },
    })
  })
}

function parseMode(args: readonly string[]): BrokerMode {
  const mode = args[0]
  if (mode !== 'accounts' && mode !== 'agent') throw new Error('Broker 模式必须是 accounts 或 agent。')
  return mode
}

function localActor() {
  return {
    osUser: localUserName(),
    hostname: os.hostname(),
    processId: process.pid,
  }
}

function localUserName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown'
  }
}

function localApiEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

function writeResponse(response: {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch(error => {
  process.stderr.write(`GeoForge 本机运维 Broker 启动失败：${errorMessage(error)}\n`)
  process.exitCode = 1
})
