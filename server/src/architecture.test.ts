// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话事实源架构测试
//
//   文件:       architecture.test.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDef } from './framework/types.js'
import type { ConversationItem } from './schemas/types.js'
import { PlatformPersistenceFacade } from './store/platformPersistenceFacade.js'
import { PersistenceFacadeTestHarness } from '../test-support/persistenceFacadeHarness.js'
import { AutomationCompiler } from './automations/automationCompiler.js'
import { automationDefinitionSchema } from './automations/schemas.js'

describe('conversation architecture', () => {
  it('keeps shared protocol schemas modular and server parsing on the shared contract', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..')
    const sharedRoot = path.join(repositoryRoot, 'packages/shared-types/src-ts')
    const serverEntry = await readFile(path.join(process.cwd(), 'src/schemas/types.ts'), 'utf8')
    const sharedEntry = await readFile(path.join(sharedRoot, 'index.ts'), 'utf8')
    const serverTsconfig = JSON.parse(await readFile(path.join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { noUncheckedIndexedAccess?: boolean }
    }

    for (const domain of ['core', 'conversation', 'runtime', 'platform', 'resources', 'transport', 'worker']) {
      await expect(stat(path.join(sharedRoot, `${domain}.ts`))).resolves.toBeDefined()
      expect(sharedEntry.includes(`export * from './${domain}.js'`), domain).toBe(true)
    }
    expect(serverEntry.trimEnd().endsWith("export * from '@geo-agent-platform/shared-types'")).toBe(true)
    expect(serverEntry.includes("from 'zod'")).toBe(false)
    expect(serverTsconfig.compilerOptions?.noUncheckedIndexedAccess).toBe(true)
  })

  it('keeps the Drizzle schema and fresh database baseline aligned on ownership foreign keys', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..')
    const schemaSource = await readFile(path.join(process.cwd(), 'src/db/schema.ts'), 'utf8')
    const baselineSource = await readFile(
      path.join(repositoryRoot, 'infra/migrations/001_init_postgis.sql'),
      'utf8',
    )
    const securityDatabaseSource = await readFile(
      path.join(process.cwd(), 'src/security/database.ts'),
      'utf8',
    )

    const drizzleForeignKeys = [
      "references(() => authUser.id, { onDelete: 'cascade' })",
      "references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' })",
      "references(() => platformUsers.userId, { onDelete: 'restrict' })",
      "references(() => platformUsers.userId, { onDelete: 'set null' })",
      "references(() => platformSessions.sessionId, { onDelete: 'cascade' })",
      "references(() => platformThreads.threadId, { onDelete: 'set null' })",
      "references(() => platformConversationEntries.entryId, { onDelete: 'set null' })",
      "references(() => platformConversationEntries.entryId, { onDelete: 'cascade' })",
      "references(() => platformMeteorologicalDatasets.datasetId, { onDelete: 'cascade' })",
      "references(() => platformRuns.runId, { onDelete: 'set null' })",
    ]
    const baselineForeignKeys = [
      'user_id      TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE',
      'created_by_user_id TEXT NOT NULL REFERENCES platform_users(user_id) ON DELETE RESTRICT',
      'workspace_id  TEXT NOT NULL REFERENCES platform_workspaces(workspace_id) ON DELETE CASCADE',
      'actor_user_id  TEXT REFERENCES platform_users(user_id) ON DELETE SET NULL',
      'session_id          TEXT REFERENCES platform_sessions(session_id) ON DELETE CASCADE',
      'thread_id           TEXT REFERENCES platform_threads(thread_id) ON DELETE SET NULL',
      'based_on_entry_id TEXT REFERENCES platform_conversation_entries(entry_id) ON DELETE SET NULL',
      'boundary_entry_id       TEXT NOT NULL REFERENCES platform_conversation_entries(entry_id) ON DELETE CASCADE',
      'dataset_id         TEXT NOT NULL REFERENCES platform_meteorological_datasets(dataset_id) ON DELETE CASCADE',
      'last_run_id        TEXT REFERENCES platform_runs(run_id) ON DELETE SET NULL',
      'run_id             TEXT REFERENCES platform_runs(run_id) ON DELETE SET NULL',
    ]

    for (const foreignKey of drizzleForeignKeys) {
      expect(schemaSource.includes(foreignKey), foreignKey).toBe(true)
    }
    for (const foreignKey of baselineForeignKeys) {
      expect(baselineSource.includes(foreignKey), foreignKey).toBe(true)
    }
    expect(securityDatabaseSource).not.toMatch(/db\.execute\(sql`\s*(?:CREATE|ALTER|DROP)\b/iu)
  })

  it('keeps removed response/message-frame models out of runtime source', async () => {
    const root = path.resolve(process.cwd(), '..')
    const files = await collectSourceFiles([
      path.join(root, 'server/src'),
      path.join(root, 'apps/web/src'),
      path.join(root, 'packages/shared-types/src-ts'),
    ])
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

    const forbidden = [
      'final' + 'Response',
      'Agent' + 'FinalResponse',
      'agent' + 'FinalResponse',
      'message' + '_fra' + 'me',
      'Agent' + 'MessageFrame',
      'append' + '_message' + '_fra' + 'me',
      'subscribe' + '_messages',
      'list' + '_messages',
      'as ' + 'any',
    ]

    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps production source free of legacy product names and local absolute paths', async () => {
    const root = path.resolve(process.cwd(), '..')
    const files = await collectProductionFiles([
      path.join(root, 'AGENTS.md'),
      path.join(root, 'server/src'),
      path.join(root, 'apps/web/src'),
      path.join(root, 'apps/worker/src'),
      path.join(root, 'packages/shared-types/src-ts'),
      path.join(root, 'packages/gis-meteorology/src/gis_meteorology'),
    ])
    const windowsAbsolutePath = /(^|[^A-Za-z])[A-Za-z]:[\\/]/u

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(source.includes('Newmap'), file).toBe(false)
      expect(source.includes('newmap'), file).toBe(false)
      expect(windowsAbsolutePath.test(source), file).toBe(false)
    }
  })

  it('keeps the Windows development stack bound to loopback explicitly', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..')
    const source = await readFile(path.join(repositoryRoot, 'dev.ps1'), 'utf8')

    expect(source.includes("Set-ProcessValue 'API_HOST' '127.0.0.1'")).toBe(true)
    expect(source.includes("Set-ProcessValue 'WEB_DEV_HOST' '127.0.0.1'")).toBe(true)
    expect(source.includes("Set-ProcessDefault 'API_HOST' '127.0.0.1'")).toBe(false)
    expect(source.includes("Set-ProcessDefault 'WEB_DEV_HOST' '127.0.0.1'")).toBe(false)
  })

  it('keeps PlatformPersistenceFacade as a resource facade instead of a writer god object', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/platformPersistenceFacade.ts'), 'utf8')
    const requiredDelegates = [
      'new SessionStore',
      'new ThreadStore',
      'new RunStore',
      'new ArtifactStore',
      'new ContentObjectGateway',
      'new ArtifactPublicationRepository',
      'new MeteorologicalStore',
      'new RuntimeConfigStore',
      'new ToolCatalogStore',
    ]
    const forbiddenWritePaths = [
      'db.execute',
      'sql`',
      'platform_',
      'payloadStore.saveSession',
      'payloadStore.createThread',
      'payloadStore.saveThread',
      'payloadStore.moveThreadToTrash',
      'payloadStore.createRun',
      'payloadStore.saveRun',
      'payloadStore.appendEvent',
      'payloadStore.appendItem',
      'payloadStore.appendTranscript',
      'payloadStore.saveMemory',
      'payloadStore.appendCompaction',
      'payloadStore.appendArtifact',
      'payloadStore.putObject',
      'payloadStore.readObject',
      'payloadStore.appendValue',
      'payloadStore.appendAgentTranscript',
      'payloadStore.saveAgentsSdkState',
      'payloadStore.readAgentsSdkState',
    ]

    for (const delegate of requiredDelegates) {
      expect(source.includes(delegate), delegate).toBe(true)
    }
    expect(source).toMatch(/private readonly payloadStore: ConversationPayloadStore/u)
    expect(source).not.toMatch(/^\s*readonly payloadStore: ConversationPayloadStore/mu)
    for (const forbidden of forbiddenWritePaths) {
      expect(source.includes(forbidden), forbidden).toBe(false)
    }
  })

  it('keeps cross-resource conversation lifecycle writes inside repository transactions', async () => {
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')
    const runSource = await readFile(path.join(process.cwd(), 'src/store/runStore.ts'), 'utf8')
    const persistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/conversationPersistence.ts'),
      'utf8',
    )
    const threadPersistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/threadLifecycleRepository.ts'),
      'utf8',
    )
    const runPersistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/runStateRepository.ts'),
      'utf8',
    )

    expect(threadSource.includes('this.repositories.lifecycle.createThreadLifecycle(thread)')).toBe(true)
    expect(threadSource.includes('this.repositories.lifecycle.trashThread(')).toBe(true)
    expect(threadSource.includes('this.sessionStore.update(')).toBe(false)
    expect(runSource.includes('this.repository.createRunLifecycle(run)')).toBe(true)
    expect(runSource.includes('this.repository.saveRunWithCheckpoint(')).toBe(true)
    expect(runSource.includes('this.sessionStore.update(')).toBe(false)

    for (const method of [
      'createThreadLifecycle',
      'trashThread',
      'restoreThread',
      'purgeThread',
    ]) {
      const methodStart = threadPersistenceSource.indexOf(
        `async ${method}(`,
        threadPersistenceSource.indexOf('export class'),
      )
      expect(methodStart, `${method} implementation`).toBeGreaterThanOrEqual(0)
      const transactionStart = threadPersistenceSource.indexOf('this.db.transaction(', methodStart)
      const nextMethodStart = threadPersistenceSource.indexOf('\n  async ', methodStart + 1)
      expect(transactionStart, `${method} transaction`).toBeGreaterThan(methodStart)
      expect(transactionStart, `${method} transaction boundary`).toBeLessThan(nextMethodStart)
    }

    const runMethodStart = runPersistenceSource.indexOf(
      'async createRunLifecycle(',
      runPersistenceSource.indexOf('export class'),
    )
    const runTransactionStart = runPersistenceSource.indexOf('this.db.transaction(', runMethodStart)
    const nextRunMethodStart = runPersistenceSource.indexOf('\n  async ', runMethodStart + 1)
    expect(runTransactionStart, 'createRunLifecycle transaction').toBeGreaterThan(runMethodStart)
    expect(runTransactionStart, 'createRunLifecycle transaction boundary').toBeLessThan(nextRunMethodStart)
  })

  it('injects narrow persistence ports into session, thread, and run stores', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const portsSource = await readFile(
      path.join(storeRoot, 'postgres/conversationPersistencePorts.ts'),
      'utf8',
    )
    const sessionSource = await readFile(path.join(storeRoot, 'sessionStore.ts'), 'utf8')
    const threadSource = await readFile(path.join(storeRoot, 'threadStore.ts'), 'utf8')
    const runSource = await readFile(path.join(storeRoot, 'runStore.ts'), 'utf8')
    const facadeSource = await readFile(path.join(storeRoot, 'platformPersistenceFacade.ts'), 'utf8')

    for (const port of [
      'ConversationSnapshotRepository',
      'SessionRepository',
      'ThreadLifecycleRepository',
      'ThreadMemoryRepository',
      'ThreadCompactionRepository',
      'ConversationTranscriptRepository',
      'ThreadRepository',
      'RunStateRepository',
      'RunCheckpointRepository',
      'RunRecordRepository',
      'RunRepository',
      'ObjectReferenceRepository',
      'RunInputRepository',
    ]) {
      expect(portsSource.includes(`interface ${port}`), port).toBe(true)
    }
    expect(sessionSource.includes('private readonly repository: SessionRepository')).toBe(true)
    expect(threadSource.includes('private readonly repositories: ThreadPersistencePorts')).toBe(true)
    expect(threadSource.includes('lifecycle: ThreadLifecycleRepository')).toBe(true)
    expect(threadSource.includes('transcript: ConversationTranscriptRepository')).toBe(true)
    expect(threadSource.includes('memory: ThreadMemoryRepository')).toBe(true)
    expect(threadSource.includes('compactions: ThreadCompactionRepository')).toBe(true)
    expect(threadSource.includes("Pick<RunRepository, 'listRunsForThread'>")).toBe(true)
    expect(runSource.includes('private readonly repository: RunRepository')).toBe(true)
    expect(runSource.includes("Pick<ThreadLifecycleRepository, 'saveThread'>")).toBe(true)
    expect(facadeSource.includes('private readonly conversationPersistence: ConversationPersistence')).toBe(false)
    expect(facadeSource.includes('private readonly snapshotRepository: ConversationSnapshotRepository')).toBe(true)
    expect(facadeSource.includes('private readonly runInputRepository: RunInputRepository')).toBe(true)
  })

  it('keeps conversation persistence split by resource ownership without legacy utility facades', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const persistenceSource = await readFile(
      path.join(storeRoot, 'postgres/conversationPersistence.ts'),
      'utf8',
    )
    const snapshotSource = await readFile(
      path.join(storeRoot, 'postgres/conversationSnapshotRepository.ts'),
      'utf8',
    )
    const sessionSource = await readFile(
      path.join(storeRoot, 'postgres/sessionRepository.ts'),
      'utf8',
    )
    const mapperSource = await readFile(
      path.join(storeRoot, 'postgres/conversationRowMappers.ts'),
      'utf8',
    )
    const threadFacadeSource = await readFile(
      path.join(storeRoot, 'postgres/threadRepository.ts'),
      'utf8',
    )
    const threadLifecycleSource = await readFile(
      path.join(storeRoot, 'postgres/threadLifecycleRepository.ts'),
      'utf8',
    )
    const threadMemorySource = await readFile(
      path.join(storeRoot, 'postgres/threadMemoryRepository.ts'),
      'utf8',
    )
    const threadCompactionSource = await readFile(
      path.join(storeRoot, 'postgres/threadCompactionRepository.ts'),
      'utf8',
    )
    const transcriptSource = await readFile(
      path.join(storeRoot, 'postgres/conversationTranscriptRepository.ts'),
      'utf8',
    )
    const runFacadeSource = await readFile(
      path.join(storeRoot, 'postgres/runRepository.ts'),
      'utf8',
    )
    const runStateSource = await readFile(
      path.join(storeRoot, 'postgres/runStateRepository.ts'),
      'utf8',
    )
    const runCheckpointSource = await readFile(
      path.join(storeRoot, 'postgres/runCheckpointRepository.ts'),
      'utf8',
    )
    const runRecordSource = await readFile(
      path.join(storeRoot, 'postgres/runRecordRepository.ts'),
      'utf8',
    )

    expect(persistenceSource.includes('new PostgresConversationSnapshotRepository(db)')).toBe(true)
    expect(persistenceSource.includes('new PostgresSessionRepository(db)')).toBe(true)
    expect(persistenceSource.includes('new PostgresThreadRepository(db, this.runMutations)')).toBe(true)
    expect(persistenceSource.includes('new PostgresRunRepository(db, this.runMutations, this.runRecords)')).toBe(true)
    expect(persistenceSource.includes('new PostgresObjectReferenceRepository(db)')).toBe(true)
    expect(persistenceSource.includes('return this.snapshots.loadSnapshot()')).toBe(true)
    expect(persistenceSource.includes('await this.sessions.saveSession(session)')).toBe(true)
    expect(snapshotSource.includes('implements ConversationSnapshotRepository')).toBe(true)
    expect(sessionSource.includes('implements SessionRepository')).toBe(true)
    expect(threadFacadeSource).toContain('implements ThreadRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadLifecycleRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadMemoryRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadCompactionRepository')
    expect(threadFacadeSource).toContain('new PostgresConversationTranscriptRepository')
    expect(threadFacadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(threadFacadeSource.includes('this.db.')).toBe(false)
    expect(threadLifecycleSource.includes('platformSessions')).toBe(true)
    expect(threadLifecycleSource.includes('platformThreadMemoryVersions')).toBe(false)
    expect(threadLifecycleSource.includes('platformConversationEntries')).toBe(false)
    expect(threadMemorySource.includes('platformThreadMemoryVersions')).toBe(true)
    expect(threadMemorySource.includes('platformConversationEntries')).toBe(false)
    expect(threadCompactionSource.includes('platformThreadCompactions')).toBe(true)
    expect(threadCompactionSource.includes('platformConversationEntries')).toBe(false)
    expect(transcriptSource.includes('platformConversationEntries')).toBe(true)
    expect(transcriptSource.includes('platformThreadMemoryVersions')).toBe(false)
    expect(runFacadeSource).toContain('implements RunRepository')
    expect(runFacadeSource).toContain('new PostgresRunStateRepository')
    expect(runFacadeSource).toContain('new PostgresRunCheckpointRepository')
    expect(runFacadeSource).toContain('new PostgresRunRecordRepository')
    expect(runFacadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(runFacadeSource.includes('this.db.')).toBe(false)
    expect(runStateSource.includes('platformSessions')).toBe(true)
    expect(runStateSource.includes('platformEventOutbox')).toBe(false)
    expect(runCheckpointSource.includes('platformRuns')).toBe(true)
    expect(runCheckpointSource.includes('platformEventOutbox')).toBe(false)
    expect(runRecordSource.includes('platformRunRecords')).toBe(true)
    expect(runRecordSource.includes('platformEventOutbox')).toBe(true)
    expect(await readFile(path.join(storeRoot, 'postgres/objectReferenceRepository.ts'), 'utf8'))
      .toContain('implements ObjectReferenceRepository')
    expect(persistenceSource.includes('this.db.')).toBe(false)
    expect(persistenceSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(mapperSource.includes('export function mapAnalysisRunRow')).toBe(true)
    expect(mapperSource.includes('export function mapThreadRow')).toBe(true)

    await expect(stat(path.join(storeRoot, 'platformStoreUtils.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'fileConversationIo.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps map persistence split by scene, layer, and feature ownership', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'mapStore.ts'), 'utf8')
    const sceneSource = await readFile(path.join(postgresRoot, 'mapSceneRepository.ts'), 'utf8')
    const layerSource = await readFile(path.join(postgresRoot, 'mapLayerRepository.ts'), 'utf8')
    const featureSource = await readFile(path.join(postgresRoot, 'mapFeatureRepository.ts'), 'utf8')

    expect(facadeSource.includes('new MapSceneRepository')).toBe(true)
    expect(facadeSource.includes('new MapLayerRepository')).toBe(true)
    expect(facadeSource.includes('new MapFeatureRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('this.db.')).toBe(false)
    expect(sceneSource.includes('platformMapScenes')).toBe(true)
    expect(sceneSource.includes('platformMapSceneLayers')).toBe(true)
    expect(layerSource.includes('platformMapLayers')).toBe(true)
    expect(featureSource.includes('platformLayerFeatures')).toBe(true)
    expect(featureSource.includes('ST_AsGeoJSON')).toBe(true)
    expect(featureSource.includes('Drizzle query builder 无对应表达式')).toBe(true)
  })

  it('keeps managed layers split into metadata, feature, scene, import, and health boundaries', async () => {
    const managedRoot = path.join(process.cwd(), 'src/gis/managedLayers')
    const facadeSource = await readFile(path.join(managedRoot, 'managedLayerService.ts'), 'utf8')
    const layerSource = await readFile(path.join(managedRoot, 'managedLayerRepository.ts'), 'utf8')
    const featureSource = await readFile(path.join(managedRoot, 'managedFeatureRepository.ts'), 'utf8')
    const sceneSource = await readFile(path.join(managedRoot, 'managedLayerSceneProjection.ts'), 'utf8')
    const importSource = await readFile(path.join(managedRoot, 'managedLayerImportService.ts'), 'utf8')
    const healthSource = await readFile(path.join(managedRoot, 'postGisHealthProbe.ts'), 'utf8')

    expect(facadeSource.includes('new ManagedLayerRepository')).toBe(true)
    expect(facadeSource.includes('new ManagedFeatureRepository')).toBe(true)
    expect(facadeSource.includes('new ManagedLayerImportService')).toBe(true)
    expect(facadeSource.includes('new PostGisHealthProbe')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('sql`')).toBe(false)

    expect(layerSource.includes('platformMapLayers')).toBe(true)
    expect(layerSource.includes('platformLayerFeatures')).toBe(false)
    expect(featureSource.includes('platformLayerFeatures')).toBe(true)
    expect(featureSource.includes('platformMapLayers')).toBe(false)
    expect(sceneSource.includes('platformMapScenes')).toBe(true)
    expect(sceneSource.includes('platformMapSceneLayers')).toBe(true)

    expect(importSource.includes('this.db.transaction')).toBe(true)
    expect(importSource.includes('this.layers.upsertImportedLayer')).toBe(true)
    expect(importSource.includes('this.features.replaceFeatures')).toBe(true)
    expect(importSource.includes('this.scenes.attach')).toBe(true)
    expect(featureSource.includes('PostGIS 专用能力')).toBe(true)
    expect(healthSource.includes('PostGIS 扩展不可用')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/gis/postgis.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps automation persistence split by definition, schedule, and run ownership', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'automationStore.ts'), 'utf8')
    const definitionSource = await readFile(path.join(postgresRoot, 'automationDefinitionRepository.ts'), 'utf8')
    const scheduleSource = await readFile(path.join(postgresRoot, 'scheduledTaskRepository.ts'), 'utf8')
    const runSource = await readFile(path.join(postgresRoot, 'automationRunRepository.ts'), 'utf8')

    expect(facadeSource.includes('new AutomationDefinitionRepository')).toBe(true)
    expect(facadeSource.includes('new ScheduledTaskRepository')).toBe(true)
    expect(facadeSource.includes('new AutomationRunRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('this.db.')).toBe(false)
    expect(definitionSource.includes('platformAutomationDefinitions')).toBe(true)
    expect(definitionSource.includes('platformAutomationVersions')).toBe(true)
    expect(scheduleSource.includes('platformScheduledTasks')).toBe(true)
    expect(runSource.includes('platformAutomationRuns')).toBe(true)
  })

  it('models artifact publication as an explicit cross-resource transaction', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const publicationSource = await readFile(
      path.join(postgresRoot, 'artifactPublicationRepository.ts'),
      'utf8',
    )
    const metadataSource = await readFile(
      path.join(postgresRoot, 'artifactMetadataRepository.ts'),
      'utf8',
    )
    const mapProjectionSource = await readFile(
      path.join(postgresRoot, 'artifactMapProjectionRepository.ts'),
      'utf8',
    )

    expect(publicationSource.includes('this.db.transaction')).toBe(true)
    expect(publicationSource.includes('this.metadata.upsert')).toBe(true)
    expect(publicationSource.includes('this.mapProjection.publish')).toBe(true)
    expect(publicationSource.includes('platformThreads')).toBe(true)
    expect(metadataSource.includes('platformArtifacts')).toBe(true)
    expect(metadataSource.includes('platformMapLayers')).toBe(false)
    expect(mapProjectionSource.includes('platformMapLayers')).toBe(true)
    expect(mapProjectionSource.includes('platformArtifacts')).toBe(false)
    await expect(stat(path.join(postgresRoot, 'artifactIndexStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps meteorological datasets and processing jobs in separate repositories', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'meteorologicalStore.ts'), 'utf8')
    const datasetSource = await readFile(
      path.join(postgresRoot, 'meteorologicalDatasetRepository.ts'),
      'utf8',
    )
    const jobSource = await readFile(
      path.join(postgresRoot, 'meteorologicalJobRepository.ts'),
      'utf8',
    )

    expect(facadeSource.includes('new MeteorologicalDatasetRepository')).toBe(true)
    expect(facadeSource.includes('new MeteorologicalJobRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(datasetSource.includes('platformMeteorologicalDatasets')).toBe(true)
    expect(datasetSource.includes('platformMeteorologicalJobs')).toBe(false)
    expect(jobSource.includes('platformMeteorologicalJobs')).toBe(true)
    expect(jobSource.includes('platformMeteorologicalDatasets')).toBe(false)
    expect(datasetSource.includes('decodeRequiredRecord')).toBe(true)
    expect(jobSource.includes('decodeRequiredRecord')).toBe(true)
    expect(datasetSource.includes("return value === 'private'")).toBe(false)
    await expect(stat(path.join(postgresRoot, 'meteorologicalDatasetStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes obsolete JSONL session facts and unused journal implementations', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    await expect(stat(path.join(storeRoot, 'sessionLog.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'journal.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats the in-memory conversation index as a rebuildable projection, not a store fact source', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const projectionSource = await readFile(path.join(storeRoot, 'conversationProjectionIndex.ts'), 'utf8')
    const errorsSource = await readFile(path.join(storeRoot, 'storeErrors.ts'), 'utf8')

    expect(projectionSource.includes('export class ConversationProjectionIndex')).toBe(true)
    expect(projectionSource.includes('PostgreSQL 会话仓储是事实源')).toBe(true)
    expect(projectionSource.includes('export class StoreNotFoundError')).toBe(false)
    expect(errorsSource.includes('export class StoreNotFoundError')).toBe(true)
    await expect(stat(path.join(storeRoot, 'conversationIndexStore.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'fileConversationStore.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'ConversationStorage.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ConversationPayloadStore compiled against the ConversationPayloadStorage port', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const portSource = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStorage.ts'), 'utf8')
    const persistenceSource = await readFile(path.join(process.cwd(), 'src/store/postgres/conversationPersistence.ts'), 'utf8')

    expect(source.includes('export class ConversationPayloadStore implements ConversationPayloadStorage')).toBe(true)
    expect(source.includes('隐式满足 ConversationPayloadStorage')).toBe(false)
    expect(portSource.includes('saveRun(')).toBe(false)
    expect(portSource.includes('saveAgentsSdkState(')).toBe(false)
    expect(portSource.includes('saveMemory(')).toBe(false)
    expect(portSource.includes('appendTranscript(')).toBe(false)
    expect(portSource.includes('appendCompaction(')).toBe(false)
    expect(portSource.includes('registerThread(')).toBe(true)
    expect(portSource.includes('readObjectByHash(')).toBe(true)
    expect(portSource.includes('appendValue(runId: string, value: ToolValueRef)')).toBe(false)
    expect(persistenceSource.includes('saveRunCheckpoint(')).toBe(true)
    expect(persistenceSource.includes('saveAgentsSdkCheckpoint(')).toBe(true)
    expect(persistenceSource.includes('saveThreadMemoryVersion(')).toBe(true)
    expect(persistenceSource.includes('appendCompaction(')).toBe(true)
  })

  it('hydrates file payload locations from PostgreSQL without recovering legacy conversation JSONL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const facadeSource = await readFile(path.join(process.cwd(), 'src/store/platformPersistenceFacade.ts'), 'utf8')
    const jsonlSource = await readFile(path.join(process.cwd(), 'src/store/durableJsonlStore.ts'), 'utf8')
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')

    expect(source.includes('async initialize(snapshot: ConversationPayloadIndex)')).toBe(true)
    expect(source.includes('for (const thread of snapshot.threads)')).toBe(true)
    expect(source.includes('for (const deleted of snapshot.deletedThreads)')).toBe(true)
    expect(source.includes('for (const run of snapshot.runs)')).toBe(true)
    expect(facadeSource.indexOf('this.snapshotRepository.loadSnapshot()'))
      .toBeLessThan(facadeSource.indexOf('this.payloadStore.initialize(snapshot)'))
    expect(source.includes('new DurableJsonlStore()')).toBe(true)
    expect(source.includes('this.jsonlStore.append')).toBe(true)
    expect(source.includes('this.jsonlStore.read')).toBe(false)
    expect(source.includes('ThreadJournalStore')).toBe(false)
    expect(source.includes('ThreadMemoryFileStore')).toBe(false)
    expect(source.includes('thread.json')).toBe(false)
    expect(threadSource.includes('this.repositories.memory.saveThreadMemoryVersion')).toBe(true)
    expect(threadSource.includes('this.repositories.compactions.appendCompaction')).toBe(true)
    expect(threadSource.includes('this.payloadStore.putObject')).toBe(true)
    expect(threadSource.includes('this.payloadStore.readObjectByHash')).toBe(true)
    expect(jsonlSource.includes('private readonly writeQueues')).toBe(true)
    for (const token of [
      'private writeQueues',
      'private enqueueAppend',
      'private async readJsonLines',
      'threadJournalSchema =',
      'private async writeThreadJournal',
      'private async applyThreadJournal',
      'private async recoverThreadJournals',
      'recordJsonLineCorruption(',
      'memory 版本冲突',
      'versions.jsonl',
      'compactions.jsonl',
      'previous append failed',
    ]) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('uses PostgreSQL advisory locking for the single API writer boundary', async () => {
    const lockSource = await readFile(path.join(process.cwd(), 'src/db/applicationInstanceLock.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const packageSource = await readFile(path.join(process.cwd(), 'package.json'), 'utf8')

    expect(lockSource.includes('pg_advisory_lock')).toBe(true)
    expect(lockSource.includes('pg_advisory_unlock')).toBe(true)
    expect(containerSource.includes('await instanceLock.acquire()')).toBe(true)
    expect(packageSource.includes('proper-lockfile')).toBe(false)
  })

  it('keeps content-addressed object IO outside ConversationPayloadStore', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const objectSource = await readFile(path.join(process.cwd(), 'src/store/contentAddressedObjectStore.ts'), 'utf8')
    const gcSource = await readFile(path.join(process.cwd(), 'src/store/conversationObjectGarbageCollector.ts'), 'utf8')

    expect(source.includes('new ContentAddressedObjectStore(this.objectsRoot)')).toBe(true)
    expect(source.includes('new ConversationObjectGarbageCollector(this.sessionsRoot, this.objectsRoot)')).toBe(true)
    expect(source.includes('return this.objectStore.put(content, mediaType)')).toBe(true)
    expect(source.includes('return this.objectStore.read(reference)')).toBe(true)
    expect(source.includes('return this.objectStore.readByHash(hash)')).toBe(true)
    expect(source.includes('return this.objectGarbageCollector.collect(databaseReferences)')).toBe(true)
    expect(gcSource.includes('databaseReferences: Iterable<string>')).toBe(true)
    expect(objectSource.includes("createHash('sha256')")).toBe(true)
    expect(gcSource.includes('collectAttachmentReferences')).toBe(true)
    for (const token of [
      "createHash('sha256')",
      "writeFile(target, bytes, { flag: 'wx' })",
      'actualHash',
      'contentRef 哈希格式无效',
      'content.matchAll',
      'collectAttachmentReferences',
    ]) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps WebSocket handler as transport-only and command-registry driven', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/ws/handler.ts'), 'utf8')
    const required = [
      'createDefaultCommandRegistry()',
      'commandRegistry.get(msg.type)',
      'commandRegistry.execute(msg',
    ]
    const forbidden = [
      'switch (msg.type)',
      'case ',
      'function handleMessage',
      'async function handleMessage',
      'executeTool(',
      'registerCoreCommands(',
      'registerThreadCommands(',
      'registerRunCommands(',
      'registerMemoryCommands(',
      'registerToolCommands(',
    ]

    for (const token of required) {
      expect(source.includes(token), token).toBe(true)
    }
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
    expect(source.includes('authenticateHeaders(toHeaders(request))')).toBe(true)
    expect(source.includes('new URL(request.url')).toBe(false)
    expect(source.includes('new Request(')).toBe(false)
  })

  it('keeps WebSocket authorization attached to the command registry', async () => {
    const securitySource = await readFile(path.join(process.cwd(), 'src/ws/security.ts'), 'utf8')
    const registrySource = await readFile(path.join(process.cwd(), 'src/ws/defaultCommandRegistry.ts'), 'utf8')
    expect(securitySource.includes('registerWsAuthorizationPolicies')).toBe(true)
    expect(registrySource.includes('registerWsAuthorizationPolicies(registry)')).toBe(true)
    expect(securitySource.includes('switch (msg.type)')).toBe(false)
    expect(securitySource.includes('authorizeWsMessage')).toBe(false)
    expect(securitySource.includes('MUTATING_COMMANDS')).toBe(false)
  })

  it('keeps ToolRegistry construction in the application composition root', async () => {
    const registrySource = await readFile(path.join(process.cwd(), 'src/framework/registry.ts'), 'utf8')
    const loaderSource = await readFile(path.join(process.cwd(), 'src/framework/loader.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')

    expect(registrySource.includes('export const toolRegistry = new ToolRegistry')).toBe(false)
    expect(loaderSource.includes("import { getEnv } from './env.js'")).toBe(false)
    expect(loaderSource.includes("import { toolRegistry } from './registry.js'")).toBe(false)
    expect(loaderSource.includes('deps: { env: Env; registry: ToolRegistry; scheduledTaskService?: ScheduledTaskService }')).toBe(true)
    expect(containerSource.includes('const toolRegistry = new ToolRegistry()')).toBe(true)
  })

  it('keeps application service construction inside AppContainer', async () => {
    const mainSource = await readFile(path.join(process.cwd(), 'src/main.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const forbiddenMainTokens = [
      'new PlatformPersistenceFacade',
      'new ManagedLayerService',
      'new ArtifactPublicationRepository',
      'new AuditStore',
      'new BetterAuthService',
      'new AuthorizationService',
      'new ToolRegistry',
      'new ModelAdapterRegistry',
      'await store.initialize',
      'await discoverAndLoad',
      'await validateToolContracts',
    ]

    expect(mainSource.includes('createAppContainer')).toBe(true)
    expect(containerSource.includes('export async function createAppContainer')).toBe(true)
    for (const token of forbiddenMainTokens) {
      expect(mainSource.includes(token), token).toBe(false)
    }
  })

  it('keeps runtime env reads in the composition root, not WS or provider modules', async () => {
    const forbiddenFiles = [
      'src/ws/controlCommands.ts',
      'src/ws/dependencies.ts',
      'src/tools/spatial/index.ts',
      'src/tools/routing/index.ts',
      'src/tools/media/index.ts',
      'src/tools/media/mediaTools.ts',
      'src/tools/meteorology/index.ts',
      'src/tools/meteorology/meteorologyTools.ts',
      'src/tools/meteorology/meteorologyWorkerClient.ts',
    ]

    for (const relativePath of forbiddenFiles) {
      const source = await readFile(path.join(process.cwd(), relativePath), 'utf8')
      expect(source.includes('getEnv()'), relativePath).toBe(false)
      expect(source.includes("import { getEnv }"), relativePath).toBe(false)
    }
  })

  it('keeps meteorology HTTP routes delegated to resource stores instead of raw CRUD SQL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/routes/meteorology.ts'), 'utf8')
    const forbidden = [
      'db.execute(sql`',
      'SELECT *',
      'INSERT INTO platform_meteorological_datasets',
      'INSERT INTO platform_meteorological_jobs',
    ]

    expect(source.includes('store.listMeteorologicalDatasets')).toBe(true)
    expect(source.includes('store.createMeteorologicalDataset')).toBe(true)
    expect(source.includes('store.getMeteorologicalJob')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps meteorology tool definition DSL outside the tool handler module', async () => {
    const toolSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const definitionSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/toolDefinition.ts'), 'utf8')

    expect(toolSource.includes("from './toolDefinition.js'")).toBe(true)
    for (const token of [
      "import { meteorologyToolPrompt } from './prompts.js'",
      'function tool(',
      'function refParameter(',
      'function textParameter(',
      'function numberParameter(',
      'function selectParameter(',
      'function jsonParameter(',
      'function miniAppMetadata(',
    ]) {
      expect(toolSource.includes(token), token).toBe(false)
    }
    for (const token of [
      'meteorologyToolPrompt(name)',
      'export function tool(',
      'export function refParameter(',
      'function miniAppMetadata(',
    ]) {
      expect(definitionSource.includes(token), token).toBe(true)
    }
  })

  it('keeps nowcast scope tools region-generic instead of Hangzhou-specific', async () => {
    const providerSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const toolSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/nowcastTools.ts'), 'utf8')
    const promptSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/prompts.ts'), 'utf8')
    const manifestSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/manifest.json'), 'utf8')
    const nowcastSource = await readFile(path.join(process.cwd(), '../packages/gis-meteorology/src/gis_meteorology/nowcast.py'), 'utf8')

    expect(providerSource.includes('createNowcastMeteorologyTools')).toBe(true)
    for (const [name, source] of Object.entries({ toolSource, promptSource, manifestSource })) {
      expect(source.includes('prepare_nowcast_scope'), name).toBe(true)
      expect(source.includes('prepare_hangzhou_nowcast_scope'), name).toBe(false)
      expect(source.includes('HANGZHOU_DISTRICTS'), name).toBe(false)
      expect(source.includes('杭州区划'), name).toBe(false)
      expect(source.includes('杭州地点'), name).toBe(false)
    }
    expect(nowcastSource.includes('杭州短时临近预报')).toBe(false)
    expect(nowcastSource.includes('杭州天气怎么样')).toBe(false)
    expect(nowcastSource.includes('目标区域短时临近预报')).toBe(true)
  })

  it('keeps meteorology provider split by tool ownership', async () => {
    const providerSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const datasetSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/datasetTools.ts'), 'utf8')
    const radarSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/radarTools.ts'), 'utf8')
    const nowcastSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/nowcastTools.ts'), 'utf8')
    const runtimeSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/toolRuntime.ts'), 'utf8')

    expect(providerSource.includes('createDatasetMeteorologyTools')).toBe(true)
    expect(providerSource.includes('createRadarMeteorologyTools')).toBe(true)
    expect(providerSource.includes('createNowcastMeteorologyTools')).toBe(true)
    for (const token of [
      'function workerDatasetTool',
      'async function inspectRadarStationCollection',
      'async function createNowcastSequence',
      'async function generateReport',
      'function requiredRefKind',
      'function artifactTarget',
    ]) {
      expect(providerSource.includes(token), token).toBe(false)
    }
    expect(datasetSource.includes('function workerDatasetTool')).toBe(true)
    expect(radarSource.includes('async function inspectRadarStationCollection')).toBe(true)
    expect(nowcastSource.includes('async function createNowcastSequence')).toBe(true)
    expect(runtimeSource.includes('export function requiredRefKind')).toBe(true)
    expect(runtimeSource.includes('export function artifactTarget')).toBe(true)
  })

  it('keeps security admin resources split behind an injected application service', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/routes.ts'), 'utf8')
    const serviceSource = await readFile(path.join(process.cwd(), 'src/security/adminService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const userSource = await readFile(path.join(process.cwd(), 'src/store/postgres/platformUserRepository.ts'), 'utf8')
    const workspaceSource = await readFile(path.join(process.cwd(), 'src/store/postgres/workspaceRepository.ts'), 'utf8')
    const membershipSource = await readFile(path.join(process.cwd(), 'src/store/postgres/membershipRepository.ts'), 'utf8')
    const policySource = await readFile(path.join(process.cwd(), 'src/store/postgres/rbacPolicyReader.ts'), 'utf8')
    const forbidden = [
      'services.db.execute',
      'new SecurityAdminStore',
      'db.execute(sql`',
      'SELECT * FROM platform_workspaces',
      'INSERT INTO platform_workspaces',
      'INSERT INTO platform_memberships',
      'DELETE FROM platform_memberships',
    ]

    expect(source.includes('services.admin.listUsers()')).toBe(true)
    expect(source.includes("zValidator('json', adminUserPatchSchema")).toBe(true)
    expect(source.includes("zValidator('json', adminWorkspaceCreateSchema")).toBe(true)
    expect(source.includes("zValidator('json', adminMembershipCreateSchema")).toBe(true)
    expect(serviceSource.includes('this.dependencies.db.transaction')).toBe(true)
    expect(serviceSource.includes('this.dependencies.workspaces.insert')).toBe(true)
    expect(serviceSource.includes('this.dependencies.memberships.insert')).toBe(true)
    expect(serviceSource.includes('platformUsers')).toBe(false)
    expect(userSource.includes('platformUsers')).toBe(true)
    expect(userSource.includes('platformWorkspaces')).toBe(false)
    expect(workspaceSource.includes('platformWorkspaces')).toBe(true)
    expect(membershipSource.includes('platformMemberships')).toBe(true)
    expect(policySource.includes('platformRbacPolicies')).toBe(true)
    expect(containerSource.includes('new SecurityAdminService')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/security/adminStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps BetterAuth delegated to a transactional identity service with resource-owned repositories', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/authService.ts'), 'utf8')
    const serviceSource = await readFile(path.join(process.cwd(), 'src/security/platformIdentityService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const sessionSource = await readFile(path.join(process.cwd(), 'src/store/postgres/authSessionRepository.ts'), 'utf8')
    const userSource = await readFile(path.join(process.cwd(), 'src/store/postgres/platformUserRepository.ts'), 'utf8')
    const membershipSource = await readFile(path.join(process.cwd(), 'src/store/postgres/membershipRepository.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_users',
      'platform_workspaces',
      'platform_memberships',
      'auth_session',
    ]

    expect(source.includes('this.identity.ensureProjection(')).toBe(true)
    expect(source.includes('new PlatformIdentityStore')).toBe(false)
    expect(serviceSource.includes('this.dependencies.db.transaction')).toBe(true)
    expect(serviceSource.includes('this.dependencies.users.upsertIdentityProjection')).toBe(true)
    expect(serviceSource.includes('this.dependencies.workspaces.ensurePersonal')).toBe(true)
    expect(serviceSource.includes('this.dependencies.memberships.insert')).toBe(true)
    expect(serviceSource.includes('platformUsers')).toBe(false)
    expect(serviceSource.includes('platformWorkspaces')).toBe(false)
    expect(serviceSource.includes('platformMemberships')).toBe(false)
    expect(sessionSource.includes('authSession')).toBe(true)
    expect(sessionSource.includes('platformUsers')).toBe(false)
    expect(userSource.includes('platformUsers')).toBe(true)
    expect(userSource.includes('platformWorkspaces')).toBe(false)
    expect(membershipSource.includes('platformMemberships')).toBe(true)
    expect(containerSource.includes('new PlatformIdentityService')).toBe(true)
    expect(containerSource.includes('new BetterAuthService({ db, env, identity: identityService })')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/security/platformIdentityStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps artifact HTTP routes delegated to the narrow ArtifactReader boundary', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/routes/artifacts.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'FROM platform_artifacts',
      'SELECT artifact_id',
    ]

    expect(source.includes('artifacts.getArtifact')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps Casbin policy persistence on the Drizzle schema boundary', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/casbinPostgresAdapter.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_rbac_policies',
      'SELECT ptype',
      'INSERT INTO platform_rbac_policies',
      'DELETE FROM platform_rbac_policies',
    ]

    expect(source.includes('platformRbacPolicies')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps authorization audit writes delegated to AuditStore', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/authorizationService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_audit_events',
      'INSERT INTO platform_audit_events',
    ]

    expect(source.includes('private readonly auditStore: AuditStore')).toBe(true)
    expect(source.includes('this.auditStore.recordEvent')).toBe(true)
    expect(containerSource.includes('const auditStore = new AuditStore(db)')).toBe(true)
    expect(containerSource.includes('new AuthorizationService(db, auditStore)')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps server and worker observability on the structured logging boundary', async () => {
    const root = path.resolve(process.cwd(), '..')
    const serverFiles = await collectSourceFiles([path.join(root, 'server/src')])
    const mainSource = await readFile(path.join(root, 'server/src/main.ts'), 'utf8')
    const wsSource = await readFile(path.join(root, 'server/src/ws/handler.ts'), 'utf8')
    const workerClientSource = await readFile(path.join(root, 'server/src/tools/meteorology/meteorologyWorkerClient.ts'), 'utf8')
    const workerSidecarSource = await readFile(path.join(root, 'apps/worker/src/worker_app/sidecar.py'), 'utf8')
    const workerLoggingSource = await readFile(path.join(root, 'apps/worker/src/worker_app/logging.py'), 'utf8')

    for (const file of serverFiles.filter(file => !/\.test\.ts$/u.test(file))) {
      const source = await readFile(file, 'utf8')
      expect(source.includes('console.'), file).toBe(false)
    }
    expect(mainSource.includes("c.header('x-geoforge-trace-id'")).toBe(true)
    expect(mainSource.includes('withLogContext')).toBe(true)
    expect(wsSource.includes('withLogContext')).toBe(true)
    expect(wsSource.includes('wsMessagesTotal')).toBe(true)
    expect(workerClientSource.includes("'x-geoforge-trace-id'")).toBe(true)
    expect(workerSidecarSource.includes('from worker_app.logging import configure_logging')).toBe(true)
    expect(workerSidecarSource.includes('class WorkerJsonFormatter')).toBe(false)
    expect(workerLoggingSource.includes('class WorkerJsonFormatter')).toBe(true)
    expect(workerSidecarSource.includes('"runtimeRoot": str(RUNTIME_ROOT)')).toBe(false)
  })

  it('keeps worker sidecar thin and delegates infrastructure boundaries', async () => {
    const root = path.resolve(process.cwd(), '..')
    const sidecarPath = path.join(root, 'apps/worker/src/worker_app/sidecar.py')
    const sidecarSource = await readFile(sidecarPath, 'utf8')
    const appFactorySource = await readFile(path.join(root, 'apps/worker/src/worker_app/app_factory.py'), 'utf8')
    const registrySource = await readFile(path.join(root, 'apps/worker/src/worker_app/tool_registry.py'), 'utf8')
    const builtinToolsSource = await readFile(path.join(root, 'apps/worker/src/worker_app/tools/__init__.py'), 'utf8')
    const inspectToolSource = await readFile(path.join(root, 'apps/worker/src/worker_app/tools/meteorological_inspect.py'), 'utf8')
    const pathSandboxSource = await readFile(path.join(root, 'apps/worker/src/worker_app/path_sandbox.py'), 'utf8')
    const authSource = await readFile(path.join(root, 'apps/worker/src/worker_app/worker_auth.py'), 'utf8')
    const requestArgsSource = await readFile(path.join(root, 'apps/worker/src/worker_app/request_args.py'), 'utf8')
    const nowcastBridgeSource = await readFile(path.join(root, 'apps/worker/src/worker_app/nowcast_bridge.py'), 'utf8')

    expect(sidecarSource.includes('create_worker_app(WorkerSettings.from_env())')).toBe(true)
    expect(appFactorySource.includes('WorkerPathSandbox')).toBe(true)
    expect(appFactorySource.includes('WorkerAuthVerifier')).toBe(true)
    expect(appFactorySource.includes('register_system_routes(')).toBe(true)
    expect(appFactorySource.includes('register_tool_routes(')).toBe(true)
    expect(appFactorySource.includes('register_builtin_tools(tool_registry)')).toBe(true)
    expect(registrySource.includes('class WorkerToolRegistry')).toBe(true)
    expect(builtinToolsSource.includes('_BUILTIN_TOOL_REGISTRARS')).toBe(true)
    expect(inspectToolSource.includes('from worker_app.sidecar import')).toBe(false)
    for (const token of [
      '@worker_tool',
      '@app.get("/health")',
      '@app.get("/tools/catalog")',
      '@app.post("/tools/{tool_name}")',
      'class ToolRequest',
      'def resolve_runtime_path',
      'def safe_relative_path',
      'def safe_path_segment',
      'def _verify_worker_authorization',
      'class WorkerJsonFormatter',
      'def required_float',
      'def nowcast_sequence_from_reference',
    ]) {
      expect(sidecarSource.includes(token), token).toBe(false)
    }
    expect(pathSandboxSource.includes('class WorkerPathSandbox')).toBe(true)
    expect(authSource.includes('class WorkerAuthVerifier')).toBe(true)
    expect(requestArgsSource.includes('def required_float')).toBe(true)
    expect(nowcastBridgeSource.includes('def nowcast_sequence_from_reference')).toBe(true)
  })

  it('keeps Agent runtime services behind narrow persistence ports', async () => {
    const root = path.resolve(process.cwd(), '..')
    const runtimePortSource = await readFile(path.join(root, 'server/src/store/runtimePorts.ts'), 'utf8')
    const productionFiles = [
      'server/src/agent/runtime.ts',
      'server/src/agent/contextManager.ts',
      'server/src/agent/toolExecutionCoordinator.ts',
      'server/src/agent/runTaskManager.ts',
      'server/src/memory/service.ts',
      'server/src/tools/resultPersistence.ts',
    ]

    expect(runtimePortSource.includes('interface AgentRuntimeStore')).toBe(true)
    expect(runtimePortSource.includes('type ToolExecutionStore')).toBe(true)
    expect(runtimePortSource.includes('type ThreadContextStore')).toBe(true)
    for (const relativePath of productionFiles) {
      const source = await readFile(path.join(root, relativePath), 'utf8')
      expect(source.includes("from '../store/platformPersistenceFacade.js'"), relativePath).toBe(false)
      expect(source.includes("from '../store/runtimePorts.js'"), relativePath).toBe(true)
    }
  })

  it('keeps short-nowcast orchestration in the generic Automation boundary', async () => {
    const root = path.resolve(process.cwd(), '..')
    const dedicatedRunner = path.join(root, 'server/src/agent/deterministicNowcastRunner.ts')
    const runtimeSource = await readFile(path.join(root, 'server/src/agent/runtime.ts'), 'utf8')
    const automation = automationDefinitionSchema.parse(JSON.parse(await readFile(
      path.join(root, 'server/config/automations/meteorological_nowcast_monitor.json'),
      'utf8',
    )))

    await expect(stat(dedicatedRunner)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runtimeSource).not.toContain('shouldRunDeterministicNowcast')
    expect(runtimeSource).not.toContain('runDeterministicNowcast')
    expect(automation.revision).toBe(5)
    expect(automation.defaultParameters.horizonMinutes).toBe(180)
    expect(automation.defaultParameters.regionLayerKey).toBe('hangzhou_districts')
    expect(automation.agentInvocation.enabled).toBe(true)
    expect(automation.graph.nodes.some(node => node.type === 'agent')).toBe(false)
    expect(automation.graph.nodes.some(node => node.type === 'tool' && node.config.toolName === 'answer_nowcast_question')).toBe(true)
    const scope = automation.graph.nodes.find(node => node.nodeId === 'query_scope')
    expect(scope?.type === 'tool' && scope.config.toolName === 'query_layer').toBe(true)
    if (!scope || scope.type !== 'tool') throw new Error('短临 Automation 缺少完整区划查询节点')
    expect(scope.config.arguments).toMatchObject({
      layerKey: { source: 'input', path: 'parameters.regionLayerKey' },
      requireComplete: { source: 'literal', value: true },
    })
    const sequence = automation.graph.nodes.find(node => node.nodeId === 'create_sequence')
    if (!sequence || sequence.type !== 'tool') throw new Error('短临 Automation 缺少序列创建节点')
    expect(sequence.config.arguments.horizon_minutes).toEqual({
      source: 'input',
      path: 'parameters.horizonMinutes',
    })
    const nowcast = automation.graph.nodes.find(node => node.nodeId === 'nowcast')
    if (!nowcast || nowcast.type !== 'tool') throw new Error('短临 Automation 缺少降水分析节点')
    expect(nowcast.config.arguments.scope_ref).toMatchObject({
      source: 'value_ref',
      nodeId: 'query_scope',
      kind: 'feature_collection',
    })
    const output = automation.graph.nodes.find(node => node.type === 'output')
    expect(output?.type === 'output' && Object.hasOwn(output.config.outputs, 'answer')).toBe(true)
    expect(output?.type === 'output' && Object.hasOwn(output.config.outputs, 'warnings')).toBe(true)
    const automationTool = (name: string): ToolDef => ({
      name,
      label: name,
      description: name,
      prompt: name,
      group: '验收',
      tags: [],
      isReadOnly: true,
      isDestructive: false,
      executionSurfaces: ['automation'],
      jsonSchema: { type: 'object', properties: {} },
      handler: async () => ({ message: '完成', payload: {}, warnings: [], resultId: 'result', source: 'test' }),
    })
    expect(new AutomationCompiler({ get: name => automationTool(name) }).validate(automation))
      .toMatchObject({ valid: true })
  })

  it('replays completed conversation items from the PostgreSQL repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-items-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '测试')
      const run = await store.createRun(session.id, '查询杭州', { threadId: thread.id })

      await store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'user', body: '查询杭州' }))
      await store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'assistant', body: '杭州有雨。' }))
      await store.appendItem(item({ runId: run.id, threadId: thread.id, itemType: 'result', role: null, body: null, metadata: { resultType: 'success' } }))
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()
      const restoredItems = await restored.listItems(run.id)

      expect(restoredItems.map((entry) => entry.itemType)).toEqual(['message', 'message', 'result'])
      expect(restoredItems[1].body).toBe('杭州有雨。')
      expect(restoredItems[2].body).toBeNull()
      expect(restored.getThread(thread.id).latestAssistantSummary).toBe('杭州有雨。')
    } finally {
      await removeTempDirectory(dir)
    }
  })

  it('replays the latest thread projection and keeps deleted threads removed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-threads-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const first = await store.createThread(session.id, '保留线程')
      const deleted = await store.createThread(session.id, '删除线程')
      await store.deleteThread(deleted.id)
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()

      expect(restored.getSession(session.id).latestThreadId).toBe(first.id)
      expect(restored.listThreadsForSession(session.id).map(thread => thread.id)).toEqual([first.id])
    } finally {
      await removeTempDirectory(dir)
    }
  })

  it('rebuilds derived indexes and pages run summaries without thread fan-out', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-run-index-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const threadIds: string[] = []

      for (let index = 0; index < 28; index += 1) {
        const thread = await store.createThread(session.id, `线程 ${index + 1}`)
        threadIds.push(thread.id)
        await store.createRun(session.id, `查询 ${index + 1}`, { threadId: thread.id })
      }

      const first = store.listRunSummaries({ sessionId: session.id, limit: 20 })
      const second = store.listRunSummaries({ sessionId: session.id, limit: 20, cursor: first.nextCursor })
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).not.toBeNull()
      expect(second.items).toHaveLength(8)
      expect(new Set([...first.items, ...second.items].map(run => run.id)).size).toBe(28)

      await store.deleteThread(threadIds[0])
      expect(store.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()
      expect(restored.listThreadsForSession(session.id)).toHaveLength(27)
      expect(restored.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
    } finally {
      await removeTempDirectory(dir)
    }
  })
})

async function collectSourceFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    await collect(root, files)
  }
  return files.filter((file) => /\.(ts|tsx)$/u.test(file))
}

async function removeTempDirectory(directory: string): Promise<void> {
  // Windows 杀毒和文件索引可能短暂持有刚关闭的 JSONL 句柄。
  // 重试只属于测试清理，不改变生产存储或关闭语义。
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })
}

async function collectProductionFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    const entry = await stat(root)
    if (entry.isDirectory()) {
      await collect(root, files)
    } else {
      files.push(root)
    }
  }
  return files.filter((file) => {
    const normalized = file.replace(/\\/gu, '/')
    if (normalized.includes('/dist/') || normalized.includes('/node_modules/')) return false
    if (normalized.includes('/original/')) return false
    if (normalized.includes('/__tests__/') || /\.test\.[^.]+$/u.test(normalized)) return false
    return /\.(ts|tsx|py|html|md|json)$/u.test(file)
  })
}

async function collect(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      await collect(fullPath, files)
    } else {
      files.push(fullPath)
    }
  }
}

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? `item_${overrides.role ?? overrides.itemType ?? 'entry'}`,
    itemType: overrides.itemType ?? 'message',
    runId: overrides.runId ?? 'run_1',
    threadId: overrides.threadId ?? 'thread_1',
    turnId: null,
    callId: null,
    role: overrides.role ?? 'assistant',
    body: overrides.body ?? null,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  }
}
