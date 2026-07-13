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
import type { ConversationItem } from './schemas/types.js'
import { PostgresPlatformStore } from './store/platformStore.js'
import { PlatformStoreTestHarness } from '../test-support/platformStoreHarness.js'

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

  it('keeps PostgresPlatformStore as a resource facade instead of a writer god object', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/platformStore.ts'), 'utf8')
    const requiredDelegates = [
      'new SessionStore',
      'new ThreadStore',
      'new RunStore',
      'new ArtifactStore',
      'new ConversationObjectStore',
      'new ArtifactIndexStore',
      'new MeteorologicalDatasetStore',
      'new RuntimeConfigStore',
      'new ToolCatalogStore',
    ]
    const forbiddenWritePaths = [
      'db.execute',
      'sql`',
      'platform_',
      'conversationStore.saveSession',
      'conversationStore.createThread',
      'conversationStore.saveThread',
      'conversationStore.moveThreadToTrash',
      'conversationStore.createRun',
      'conversationStore.saveRun',
      'conversationStore.appendEvent',
      'conversationStore.appendItem',
      'conversationStore.appendTranscript',
      'conversationStore.saveMemory',
      'conversationStore.appendCompaction',
      'conversationStore.appendArtifact',
      'conversationStore.putObject',
      'conversationStore.readObject',
      'conversationStore.appendValue',
      'conversationStore.appendAgentTranscript',
      'conversationStore.saveAgentsSdkState',
      'conversationStore.readAgentsSdkState',
    ]

    for (const delegate of requiredDelegates) {
      expect(source.includes(delegate), delegate).toBe(true)
    }
    expect(source).toMatch(/private readonly conversationStore: FileConversationStore/u)
    expect(source).not.toMatch(/^\s*readonly conversationStore: FileConversationStore/mu)
    for (const forbidden of forbiddenWritePaths) {
      expect(source.includes(forbidden), forbidden).toBe(false)
    }
  })

  it('keeps cross-resource conversation lifecycle writes inside repository transactions', async () => {
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')
    const runSource = await readFile(path.join(process.cwd(), 'src/store/runStore.ts'), 'utf8')
    const repositorySource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/conversationRepository.ts'),
      'utf8',
    )

    expect(threadSource.includes('this.repository.createThreadLifecycle(thread)')).toBe(true)
    expect(threadSource.includes('this.repository.trashThread(')).toBe(true)
    expect(threadSource.includes('this.sessionStore.update(')).toBe(false)
    expect(runSource.includes('this.repository.createRunLifecycle(run)')).toBe(true)
    expect(runSource.includes('this.repository.saveRunWithCheckpoint(')).toBe(true)
    expect(runSource.includes('this.sessionStore.update(')).toBe(false)

    for (const method of [
      'createThreadLifecycle',
      'trashThread',
      'restoreThread',
      'purgeThread',
      'createRunLifecycle',
    ]) {
      const methodStart = repositorySource.indexOf(`async ${method}(`, repositorySource.indexOf('export class'))
      expect(methodStart, `${method} implementation`).toBeGreaterThanOrEqual(0)
      const transactionStart = repositorySource.indexOf('this.db.transaction(', methodStart)
      const nextMethodStart = repositorySource.indexOf('\n  async ', methodStart + 1)
      expect(transactionStart, `${method} transaction`).toBeGreaterThan(methodStart)
      expect(transactionStart, `${method} transaction boundary`).toBeLessThan(nextMethodStart)
    }
  })

  it('keeps FileConversationStore compiled against the ConversationStorage port', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/fileConversationStore.ts'), 'utf8')
    const portSource = await readFile(path.join(process.cwd(), 'src/store/ConversationStorage.ts'), 'utf8')
    const repositorySource = await readFile(path.join(process.cwd(), 'src/store/postgres/conversationRepository.ts'), 'utf8')

    expect(source.includes('export class FileConversationStore implements ConversationStorage')).toBe(true)
    expect(source.includes('隐式满足 ConversationStorage')).toBe(false)
    expect(portSource.includes('saveRun(')).toBe(false)
    expect(portSource.includes('saveAgentsSdkState(')).toBe(false)
    expect(portSource.includes('saveMemory(')).toBe(false)
    expect(portSource.includes('appendTranscript(')).toBe(false)
    expect(portSource.includes('appendCompaction(')).toBe(false)
    expect(portSource.includes('registerThread(')).toBe(true)
    expect(portSource.includes('readObjectByHash(')).toBe(true)
    expect(portSource.includes('appendValue(runId: string, value: ToolValueRef)')).toBe(false)
    expect(repositorySource.includes('saveRunCheckpoint(')).toBe(true)
    expect(repositorySource.includes('saveAgentsSdkCheckpoint(')).toBe(true)
    expect(repositorySource.includes('saveThreadMemoryVersion(')).toBe(true)
    expect(repositorySource.includes('appendCompaction(')).toBe(true)
  })

  it('hydrates file payload locations from PostgreSQL without recovering legacy conversation JSONL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/fileConversationStore.ts'), 'utf8')
    const facadeSource = await readFile(path.join(process.cwd(), 'src/store/platformStore.ts'), 'utf8')
    const jsonlSource = await readFile(path.join(process.cwd(), 'src/store/durableJsonlStore.ts'), 'utf8')
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')

    expect(source.includes('async initialize(snapshot: ConversationStorageSnapshot)')).toBe(true)
    expect(source.includes('for (const thread of snapshot.threads)')).toBe(true)
    expect(source.includes('for (const deleted of snapshot.deletedThreads)')).toBe(true)
    expect(source.includes('for (const run of snapshot.runs)')).toBe(true)
    expect(facadeSource.indexOf('this.conversationRepository.loadSnapshot()'))
      .toBeLessThan(facadeSource.indexOf('this.conversationStore.initialize(snapshot)'))
    expect(source.includes('new DurableJsonlStore()')).toBe(true)
    expect(source.includes('this.jsonlStore.append')).toBe(true)
    expect(source.includes('this.jsonlStore.read')).toBe(false)
    expect(source.includes('ThreadJournalStore')).toBe(false)
    expect(source.includes('ThreadMemoryFileStore')).toBe(false)
    expect(source.includes('thread.json')).toBe(false)
    expect(threadSource.includes('this.repository.saveThreadMemoryVersion')).toBe(true)
    expect(threadSource.includes('this.repository.appendCompaction')).toBe(true)
    expect(threadSource.includes('this.conversationStore.putObject')).toBe(true)
    expect(threadSource.includes('this.conversationStore.readObjectByHash')).toBe(true)
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

  it('keeps content-addressed object IO outside FileConversationStore', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/fileConversationStore.ts'), 'utf8')
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
      'new PostgresPlatformStore',
      'new PostGisRepository',
      'new ArtifactIndexStore',
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

  it('keeps security admin routes delegated to SecurityAdminStore instead of raw CRUD SQL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/routes.ts'), 'utf8')
    const forbidden = [
      'services.db.execute',
      'db.execute(sql`',
      'SELECT * FROM platform_workspaces',
      'INSERT INTO platform_workspaces',
      'INSERT INTO platform_memberships',
      'DELETE FROM platform_memberships',
    ]

    expect(source.includes('new SecurityAdminStore(services.db)')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps BetterAuthService delegated to PlatformIdentityStore for platform projections', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/authService.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_users',
      'platform_workspaces',
      'platform_memberships',
      'auth_session',
    ]

    expect(source.includes('new PlatformIdentityStore(db)')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps artifact HTTP routes delegated to ArtifactIndexStore instead of raw lookup SQL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/routes/artifacts.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'FROM platform_artifacts',
      'SELECT artifact_id',
    ]

    expect(source.includes('artifactIndexStore.getArtifact')).toBe(true)
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
      'server/src/agent/deterministicNowcastRunner.ts',
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
      expect(source.includes("from '../store/platformStore.js'"), relativePath).toBe(false)
      expect(source.includes("from '../store/runtimePorts.js'"), relativePath).toBe(true)
    }
  })

  it('replays completed conversation items from the PostgreSQL repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-items-'))
    try {
      const harness = new PlatformStoreTestHarness()
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
      const harness = new PlatformStoreTestHarness()
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
      const harness = new PlatformStoreTestHarness()
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
