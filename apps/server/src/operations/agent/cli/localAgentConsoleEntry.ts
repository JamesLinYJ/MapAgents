// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机 Agent 命令行入口
//
//   文件:       localAgentConsoleEntry.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
} from '@geo-agent-platform/operations-supervisor'
import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { config as loadDotEnv } from 'dotenv'
import { z } from 'zod'

import { createDb } from '../../../db/connection.js'
import { parseEnv } from '../../../framework/env.js'
import { BetterAuthService } from '../../../security/authService.js'
import { ensureSecurityTables } from '../../../security/database.js'
import { PlatformIdentityService } from '../../../security/platformIdentityService.js'
import { AuditStore } from '../../../store/postgres/auditStore.js'
import { AuthSessionRepository } from '../../../store/postgres/authSessionRepository.js'
import { MembershipRepository } from '../../../store/postgres/membershipRepository.js'
import { PlatformUserRepository } from '../../../store/postgres/platformUserRepository.js'
import { WorkspaceRepository } from '../../../store/postgres/workspaceRepository.js'
import {
  formatLocalAgentCliResult,
  localAgentHelpText,
  parseLocalAgentCli,
  readPipedPrompt,
  runLocalAgentOneShot,
} from './localAgentCli.js'
import { LocalAgentSession } from '../application/localAgentSession.js'
import { LocalAgentClient } from '../transport/localAgentClient.js'
import { runLocalAgentConsole } from '../ui/localAgentConsole.js'

const packageSchema = z.object({ version: z.string().min(1) })

async function main(): Promise<void> {
  const options = parseLocalAgentCli(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(localAgentHelpText())
    return
  }

  const projectRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('GeoForge 项目根目录不存在。')
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
    await ensureSecurityTables(db)
    const users = new PlatformUserRepository(db)
    const memberships = new MembershipRepository(db)
    const identity = new PlatformIdentityService({
      db,
      users,
      workspaces: new WorkspaceRepository(db),
      memberships,
      authSessions: new AuthSessionRepository(db),
    })
    const auth = new BetterAuthService({ db, env, identity })
    const audit = new AuditStore(db)
    await auth.withLocalAgentAuthorization(rootSecret, async authorization => {
      const actor = {
        osUser: localUserName(),
        hostname: os.hostname(),
        processId: process.pid,
        keyVersion: authorization.keyVersion,
        transport: 'loopback_websocket',
      }
      await audit.recordEvent({
        actorUserId: authorization.authContext.userId,
        workspaceId: authorization.authContext.defaultWorkspaceId,
        action: 'local_agent.session.open',
        objectType: 'system',
        objectId: null,
        outcome: 'allowed',
        metadata: actor,
      })

      const endpoint = localApiEndpoint(env.API_PORT)
      const origin = new URL(env.APP_BASE_URL).origin
      const session = new LocalAgentSession({
        connectClient: () => LocalAgentClient.connect({
          appBaseUrl: endpoint,
          origin,
          headers: authorization.headers,
          csrfToken: authorization.authContext.csrfToken,
        }),
        executionMode: options.executionMode,
        reasoning: options.reasoning,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
      })

      let outcome: 'allowed' | 'error' = 'allowed'
      let runId: string | null = null
      let threadId: string | null = null
      try {
        const ready = await session.initialize()
        if (options.check) {
          const check = {
            ok: true,
            status: 'ready',
            provider: ready.provider?.provider ?? null,
            model: ready.model,
            workspaceId: ready.bootstrap?.session.workspaceId ?? null,
            connection: ready.connection,
          }
          process.stdout.write(options.json
            ? `${JSON.stringify(check, null, 2)}\n`
            : `GeoForge 本机 Agent 已就绪：${ready.provider?.displayName ?? '未知 Provider'} / ${ready.model ?? '未知模型'}。\n`)
          return
        }

        const prompt = options.prompt ?? await readPipedPrompt()
        if (prompt) {
          const oneShot = await runLocalAgentOneShot(session, prompt, options.timeoutMs)
          runId = oneShot.result.runId
          threadId = oneShot.result.threadId
          process.stdout.write(formatLocalAgentCliResult(oneShot.result, options.json))
          process.exitCode = oneShot.exitCode
          return
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error('非交互终端必须通过 --prompt 或标准输入提供问题。')
        }
        const version = await readProjectVersion(projectRoot)
        await runLocalAgentConsole(session, {
          version,
          projectRoot,
          osUser: actor.osUser,
          hostname: actor.hostname,
          keyVersion: authorization.keyVersion,
        })
        runId = session.snapshot().run?.id ?? null
        threadId = session.snapshot().threadId
      } catch (error) {
        outcome = 'error'
        throw error
      } finally {
        const latest = session.snapshot()
        runId ??= latest.run?.id ?? null
        threadId ??= latest.threadId
        session.close()
        await audit.recordEvent({
          actorUserId: authorization.authContext.userId,
          workspaceId: authorization.authContext.defaultWorkspaceId,
          action: 'local_agent.session.close',
          objectType: 'system',
          objectId: runId,
          outcome,
          metadata: {
            ...actor,
            threadId,
            runId,
            runStatus: latest.run?.status ?? null,
          },
        })
      }
    })
  } finally {
    await db.close().catch(() => undefined)
  }
}

function localApiEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

async function readProjectVersion(projectRoot: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  return packageSchema.parse(value).version
}

function localUserName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown'
  }
}

main().catch(error => {
  const message = error instanceof Error && error.message ? error.message : '未知错误。'
  process.stderr.write(`GeoForge 本机 Agent 启动失败：${message.replace(/[\r\n]+/gu, ' ')}\n`)
  process.exitCode = 1
})
