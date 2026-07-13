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
import { OpenAIAgentsRuntime } from '../agent/runtime.js'
import { RunTaskManager } from '../agent/runTaskManager.js'
import { createDb, type Database } from '../db/connection.js'
import { ApplicationInstanceLock } from '../db/applicationInstanceLock.js'
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
import { UsageStatsService } from '../usage/usageStatsService.js'
import { BackgroundTaskRegistry } from '../workflows/backgroundTaskRegistry.js'
import { JobQueueService } from '../workflows/jobQueueService.js'
import { ScheduledTaskService } from '../workflows/scheduledTaskService.js'
import { WorkflowRunner } from '../workflows/workflowRunner.js'
import { createWorkflowRegistryFromDirectory, type WorkflowRegistry } from '../workflows/workflowRegistry.js'
import { WorkflowCompiler } from '../workflows/workflowCompiler.js'
import { WorkflowDefinitionService } from '../workflows/workflowDefinitionService.js'

export interface AppContainer {
  env: Env
  db: Database
  instanceLock: ApplicationInstanceLock
  runtimeRoot: string
  store: PostgresPlatformStore
  postgis: PostGisRepository
  artifactIndexStore: ArtifactIndexStore
  auditStore: AuditStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
  workflowRegistry: WorkflowRegistry
  workflowDefinitionService: WorkflowDefinitionService
  scheduledTaskService: ScheduledTaskService
  backgroundTasks: BackgroundTaskRegistry
  usageStats: UsageStatsService
  jobQueue: JobQueueService
  security: SecurityServices
  defaultRuntimeConfig: ReturnType<typeof defaultRuntimeConfig>
  shutdown(): Promise<void>
  checkReadiness(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }>
}

export async function createAppContainer(input: { env: Env; projectRoot: string }): Promise<AppContainer> {
  const { env, projectRoot } = input
  const db = createDb(env.DATABASE_URL)
  const instanceLock = new ApplicationInstanceLock(db)
  const runtimeRoot = path.resolve(env.RUNTIME_ROOT)
  const store = new PostgresPlatformStore(db, path.join(runtimeRoot, 'conversations'))
  const postgis = new PostGisRepository(db)
  const artifactIndexStore = new ArtifactIndexStore(db)
  const auditStore = new AuditStore(db)
  const toolRegistry = new ToolRegistry()
  const modelRegistry = new ModelAdapterRegistry(env)
  const security: SecurityServices = {
    auth: new BetterAuthService(db, env),
    authorization: new AuthorizationService(db, auditStore),
    db,
  }
  const runtimeConfigDefaults = defaultRuntimeConfig({
    sandbox: {
      backend: env.SANDBOX_BACKEND,
      dockerImage: env.SANDBOX_DOCKER_IMAGE,
    },
  })
  let startedJobQueue: JobQueueService | null = null

  try {
    await instanceLock.acquire()
    await ensureMeteorologicalTables(db)
    await ensureSecurityTables(db)
    await store.initialize()

  if (env.SEED_LAYERS_DIR) {
    const seedDirectory = path.resolve(projectRoot, env.SEED_LAYERS_DIR)
    const seededLayers = await seedLayersFromDirectory(postgis, seedDirectory)
    logger.info({ count: seededLayers.length, seedLayersConfigured: true }, 'seeded layers')
  }

  const runtime = new OpenAIAgentsRuntime(store, toolRegistry, modelRegistry)
  const usageStats = new UsageStatsService(store, env)
  const backgroundTasks = new BackgroundTaskRegistry()
  const runTasks = new RunTaskManager(runtime, store, backgroundTasks)
  const workflowRegistry = await createWorkflowRegistryFromDirectory(path.join(projectRoot, 'server', 'config', 'workflows'))
  const workflowCompiler = new WorkflowCompiler(toolRegistry)
  const workflowDefinitionService = new WorkflowDefinitionService({
    store,
    registry: workflowRegistry,
    compiler: workflowCompiler,
    security,
  })
  const jobQueue = new JobQueueService(env)
  const scheduledTaskService = new ScheduledTaskService({
    store,
    definitions: workflowDefinitionService,
    compiler: workflowCompiler,
    jobQueue,
    backgroundTasks,
    runTasks,
    usageStats,
    security,
  })
  const workflowRunner = new WorkflowRunner({
    store,
    definitions: workflowDefinitionService,
    compiler: workflowCompiler,
    toolRegistry,
    runTasks,
    modelRegistry,
    security,
    usageStats,
    backgroundTasks,
    defaultRuntimeConfig: runtimeConfigDefaults,
    unscheduleTask: async taskId => {
      const task = await store.getScheduledTask(taskId)
      await jobQueue.unscheduleTask(taskId, task?.queueJobId)
    },
  })
  await discoverAndLoad(postgis, { env, registry: toolRegistry, scheduledTaskService })
  await validateWorkerContracts(env, toolRegistry)
  await workflowDefinitionService.initialize()
  await jobQueue.start((payload, queueJobId) => workflowRunner.executeQueuedJob(payload, queueJobId))
  startedJobQueue = jobQueue
  await scheduledTaskService.reconcileSchedules()

  return {
    env,
    db,
    instanceLock,
    runtimeRoot,
    store,
    postgis,
    artifactIndexStore,
    auditStore,
    toolRegistry,
    modelRegistry,
    runtime,
    runTasks,
    workflowRegistry,
    workflowDefinitionService,
    scheduledTaskService,
    backgroundTasks,
    usageStats,
    jobQueue,
    security,
    defaultRuntimeConfig: runtimeConfigDefaults,
    shutdown: async () => {
      await jobQueue.stop()
      await Promise.all([runTasks.drain(), backgroundTasks.drain()])
    },
    checkReadiness: () => checkReadiness({ db, postgis, instanceLock, env }),
  }
  } catch (error) {
    logger.error({ error: errorLogPayload(error) }, 'application container initialization failed')
    if (startedJobQueue) {
      await startedJobQueue.stop().catch(cleanupError => {
        logger.error({ error: errorLogPayload(cleanupError) }, 'job queue cleanup after startup failure failed')
      })
    }
    await store.closeConversationStore().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'conversation store cleanup after startup failure failed')
    })
    await instanceLock.release().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'instance lock cleanup after startup failure failed')
    })
    await db.close().catch(cleanupError => {
      logger.error({ error: errorLogPayload(cleanupError) }, 'database cleanup after startup failure failed')
    })
    throw error
  }
}

async function validateWorkerContracts(env: Env, toolRegistry: ToolRegistry): Promise<void> {
  if (!env.WORKER_URL) return
  if (!env.WORKER_SHARED_SECRET) {
    throw new Error('WORKER_URL 已配置但 WORKER_SHARED_SECRET 未配置。')
  }
  const contractReport = await validateToolContracts(toolRegistry, env.WORKER_URL, env.WORKER_SHARED_SECRET)
  if (!contractReport.passed) {
    const reasons = [
      ...contractReport.errors,
      ...contractReport.missingInRegistry.map(name => `Node 工具目录缺少 ${name}`),
      ...contractReport.missingInWorker.map(name => `Worker 工具目录缺少 ${name}`),
    ]
    throw new Error(`工具契约校验失败：${reasons.join('；')}`)
  }
}

async function checkReadiness(input: {
  db: Database
  postgis: PostGisRepository
  instanceLock: ApplicationInstanceLock
  env: Env
}): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}
  checks.instanceLock = input.instanceLock.isHeld()
    ? { ok: true }
    : { ok: false, detail: 'PostgreSQL 平台单写实例锁未持有' }
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
