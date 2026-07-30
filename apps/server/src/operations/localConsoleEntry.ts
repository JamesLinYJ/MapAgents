// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本地运维台入口
//
//   文件:       localConsoleEntry.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-22):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 改为连接独立 TypeScript 监督器，并将账户数据面延迟到对应页面。
// --------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
} from '@geo-agent-platform/operations-supervisor'
import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { config as loadDotEnv } from 'dotenv'

import { createDb } from '../db/connection.js'
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
import { runLocalConsole } from './localConsole.js'
import type { LocalConsoleDataPlane } from './localConsoleTypes.js'

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('GeoForge 项目根目录不存在。')
  const profile: OperationsProfile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile,
    ...(process.env.RUNTIME_ROOT ? { runtimeRoot: path.resolve(projectRoot, process.env.RUNTIME_ROOT) } : {}),
    ...(process.env.GEOFORGE_SUPERVISOR_TOKEN_FILE
      ? { tokenFile: path.resolve(projectRoot, process.env.GEOFORGE_SUPERVISOR_TOKEN_FILE) }
      : {}),
    ...(process.env.GEOFORGE_LOCAL_ROOT_SECRET_FILE
      ? { rootSecretFile: path.resolve(projectRoot, process.env.GEOFORGE_LOCAL_ROOT_SECRET_FILE) }
      : {}),
  })
  const connectSupervisor = async (): Promise<OperationsClient> => {
    const token = (await readFile(paths.tokenFile, 'utf8')).trim()
    return OperationsClient.connect({ endpoint: paths.endpoint, token, interactive: true })
  }
  const openDataPlane = createDataPlaneFactory({ projectRoot, profile, rootSecretFile: paths.rootSecretFile })

  if (process.argv.includes('--check')) {
    const client = await connectSupervisor()
    try {
      await client.status()
      process.stdout.write('GeoForge 本地运维台与 TypeScript 监督 IPC 已就绪。\n')
    } finally {
      client.close()
    }
    return
  }

  await runLocalConsole({
    connectSupervisor,
    openDataPlane,
    minPasswordLength: readMinimumPasswordLength(),
  })
}

function createDataPlaneFactory(input: {
  projectRoot: string
  profile: OperationsProfile
  rootSecretFile: string
}): () => Promise<LocalConsoleDataPlane> {
  let current: Promise<LocalConsoleDataPlane> | null = null
  return () => {
    current ??= openDataPlane(input).catch(error => {
      current = null
      throw error
    })
    return current
  }
}

async function openDataPlane(input: {
  projectRoot: string
  profile: OperationsProfile
  rootSecretFile: string
}): Promise<LocalConsoleDataPlane> {
  const env = parseEnv(process.env)
  const rootSecret = await ensureSecretFile(input.rootSecretFile, input.profile === 'development')
  if (input.profile === 'production') await assertProductionSecretPermissions(input.rootSecretFile)
  const rootKeyVersion = deriveLocalConsoleCredential(rootSecret).keyVersion
  const db = createDb(env.DATABASE_URL)
  try {
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
    const accounts = new LocalAccountService({
      db,
      auth,
      identity,
      accounts: new LocalAccountRepository(db),
      users,
      workspaces,
      memberships,
      audit,
      actor: {
        osUser: localUserName(),
        hostname: os.hostname(),
        processId: process.pid,
      },
      rootSecret,
      rootKeyVersion,
      minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    })
    return {
      accounts,
      listAuditEvents: limit => audit.listRecent(limit),
      close: () => db.close(),
    }
  } catch (error) {
    await db.close().catch(() => undefined)
    throw error
  }
}

function readMinimumPasswordLength(): number {
  const value = Number(process.env.BETTER_AUTH_MIN_PASSWORD_LENGTH ?? 12)
  return Number.isInteger(value) && value >= 8 && value <= 128 ? value : 12
}

function localUserName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown'
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '未知错误。'
  process.stderr.write(`GeoForge 本地运维台启动失败：${message}\n`)
  process.exitCode = 1
})
