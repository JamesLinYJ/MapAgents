// +-------------------------------------------------------------------------
//
//   地理智能平台 - 应用依赖装配容器
//
//   文件:       container.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import path from 'node:path'
import { sql } from 'drizzle-orm'

import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { createDb, type Database } from '../db/connection.js'
import type { Env } from '../framework/env.js'
import { discoverAndLoad } from '../framework/loader.js'
import { ToolRegistry } from '../framework/registry.js'
import { PostGisRepository } from '../gis/postgis.js'
import { seedLayersFromDirectory } from '../gis/seedLayers.js'
import { ModelAdapterRegistry } from '../model/registry.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { ensureMeteorologicalTables } from '../routes/meteorology.js'
import { ensureSecurityTables } from '../security/database.js'
import { BetterAuthService } from '../security/authService.js'
import { AuthorizationService } from '../security/authorizationService.js'
import type { SecurityServices } from '../security/routes.js'
import { PostgresPlatformStore } from '../store/platformStore.js'
import { ArtifactIndexStore } from '../store/postgres/artifactIndexStore.js'
import { AuditStore } from '../store/postgres/auditStore.js'
import { validateToolContracts } from '../tools/contractValidator.js'

export interface AppContainer {
  env: Env
  db: Database
  runtimeRoot: string
  store: PostgresPlatformStore
  postgis: PostGisRepository
  artifactIndexStore: ArtifactIndexStore
  auditStore: AuditStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  security: SecurityServices
  defaultRuntimeConfig: ReturnType<typeof defaultRuntimeConfig>
  checkReadiness(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }>
}

export async function createAppContainer(input: { env: Env; projectRoot: string }): Promise<AppContainer> {
  const { env, projectRoot } = input
  const db = createDb(env.DATABASE_URL)
  const runtimeRoot = path.resolve(env.RUNTIME_ROOT)
  const store = new PostgresPlatformStore(db, path.join(runtimeRoot, 'conversations'))
  const postgis = new PostGisRepository(db)
  const artifactIndexStore = new ArtifactIndexStore(db)
  const auditStore = new AuditStore(db)
  const toolRegistry = new ToolRegistry()
  const modelRegistry = new ModelAdapterRegistry(env)
  const runtimeConfigDefaults = defaultRuntimeConfig({
    sandbox: {
      backend: env.SANDBOX_BACKEND,
      dockerImage: env.SANDBOX_DOCKER_IMAGE,
    },
  })

  await ensureMeteorologicalTables(db)
  await ensureSecurityTables(db)
  await store.initialize()

  if (env.SEED_LAYERS_DIR) {
    const seedDirectory = path.resolve(projectRoot, env.SEED_LAYERS_DIR)
    const seededLayers = await seedLayersFromDirectory(postgis, seedDirectory)
    logger.info({ count: seededLayers.length, seedLayersConfigured: true }, 'seeded layers')
  }

  await discoverAndLoad(postgis, { env, registry: toolRegistry })
  await validateWorkerContracts(env, toolRegistry)

  const security: SecurityServices = {
    auth: new BetterAuthService(db, env),
    authorization: new AuthorizationService(db, auditStore),
    db,
  }

  return {
    env,
    db,
    runtimeRoot,
    store,
    postgis,
    artifactIndexStore,
    auditStore,
    toolRegistry,
    modelRegistry,
    security,
    defaultRuntimeConfig: runtimeConfigDefaults,
    checkReadiness: () => checkReadiness({ db, postgis, env }),
  }
}

async function validateWorkerContracts(env: Env, toolRegistry: ToolRegistry): Promise<void> {
  if (!env.WORKER_URL) return
  if (!env.WORKER_SHARED_SECRET) {
    logger.error('WORKER_URL 已配置但 WORKER_SHARED_SECRET 未配置——服务启动中止')
    process.exit(1)
  }
  const contractReport = await validateToolContracts(toolRegistry, env.WORKER_URL, env.WORKER_SHARED_SECRET)
  if (!contractReport.passed) {
    logger.error({ contractReport }, '工具契约校验失败——服务启动中止')
    process.exit(1)
  }
}

async function checkReadiness(input: {
  db: Database
  postgis: PostGisRepository
  env: Env
}): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}
  try {
    // Health check 是明确允许的 raw SQL：只验证数据库连接可用性，不读写业务表。
    await input.db.execute(sql`SELECT 1`)
    checks.database = { ok: true }
  } catch (error) {
    logger.error({ error: errorLogPayload(error) }, 'database health check failed')
    checks.database = { ok: false, detail: '数据库不可用' }
  }

  const postgisStatus = await input.postgis.status()
  if (postgisStatus.available) {
    checks.postgis = { ok: true }
  } else {
    if (postgisStatus.error) logger.error({ error: errorLogPayload(postgisStatus.error) }, 'postgis health check failed')
    checks.postgis = { ok: false, detail: 'PostGIS 不可用' }
  }

  if (input.env.WORKER_URL) {
    try {
      const response = await fetch(new URL('/health', input.env.WORKER_URL).toString(), { signal: AbortSignal.timeout(2_000) })
      checks.worker = response.ok ? { ok: true } : { ok: false, detail: `Worker HTTP ${response.status}` }
    } catch (error) {
      logger.error({ error: errorLogPayload(error) }, 'worker health check failed')
      checks.worker = { ok: false, detail: 'Worker 不可用' }
    }
  }

  return {
    status: Object.values(checks).every(check => check.ok) ? 'ok' : 'degraded',
    checks,
  }
}
