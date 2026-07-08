// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台持久化门面
//
//   文件:       platformStore.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Database } from '../db/connection.js'
import type {
  SessionRecord, AgentThreadRecord, AnalysisRun, RunSummary, AgentState,
  RunEvent, ConversationItem, AgentRuntimeConfig, ArtifactRef, ContentRef,
  RunCheckpoint, TranscriptEntry, TranscriptEntryKind, ThreadManifest,
  ThreadMemoryDocument, CompactionRecord, MeteorologicalDatasetRecord,
  MeteorologicalJobRecord, ToolValueRef,
} from '../schemas/types.js'
import { ArtifactStore } from './artifactStore.js'
import { ConversationIndexStore, StoreNotFoundError } from './conversationIndexStore.js'
import { ConversationObjectStore } from './conversationObjectStore.js'
import { InMemoryEventBus } from './eventBus.js'
import { FileConversationStore, type TrashEntry } from './fileConversationStore.js'
import { RunStore } from './runStore.js'
import { DEFAULT_SESSION_ID, SessionStore, type ResourceOwner } from './sessionStore.js'
import { ThreadStore } from './threadStore.js'
import path from 'node:path'
import { ArtifactIndexStore } from './postgres/artifactIndexStore.js'
import { MeteorologicalDatasetStore } from './postgres/meteorologicalDatasetStore.js'
import { RuntimeConfigStore } from './postgres/runtimeConfigStore.js'
import { ToolCatalogStore, type ToolCatalogEntry } from './postgres/toolCatalogStore.js'

export { StoreNotFoundError } from './conversationIndexStore.js'

export type { ToolCatalogEntry } from './postgres/toolCatalogStore.js'

export type { ResourceOwner } from './sessionStore.js'

export class PostgresPlatformStore {
  static readonly DEFAULT_SESSION_ID = DEFAULT_SESSION_ID

  readonly eventBus = new InMemoryEventBus<RunEvent>()
  readonly itemBus = new InMemoryEventBus<ConversationItem>()
  readonly runBus = new InMemoryEventBus<AnalysisRun>()
  readonly threadEntryBus = new InMemoryEventBus<TranscriptEntry>()
  readonly threadUpdateBus = new InMemoryEventBus<{ thread: AgentThreadRecord; manifest: ThreadManifest }>()
  readonly threadCompactionBus = new InMemoryEventBus<CompactionRecord>()
  readonly threadMemoryBus = new InMemoryEventBus<ThreadMemoryDocument>()
  readonly conversationStore: FileConversationStore
  readonly conversationStoreRoot: string
  readonly runtimeRoot: string

  private readonly index = new ConversationIndexStore()
  private readonly sessionStore: SessionStore
  private readonly threadStore: ThreadStore
  private readonly runStore: RunStore
  private readonly artifactStore: ArtifactStore
  private readonly objectStore: ConversationObjectStore
  private readonly meteorologicalDatasetStore: MeteorologicalDatasetStore
  private readonly runtimeConfigStore: RuntimeConfigStore
  private readonly toolCatalogStore: ToolCatalogStore

  constructor(db: Database, storageRoot: string) {
    this.conversationStoreRoot = storageRoot
    this.runtimeRoot = ['sessions', 'conversations'].includes(path.basename(storageRoot))
      ? path.dirname(storageRoot)
      : storageRoot
    this.conversationStore = new FileConversationStore(storageRoot)
    this.sessionStore = new SessionStore(this.index, this.conversationStore)
    this.threadStore = new ThreadStore(this.index, this.conversationStore, this.sessionStore, this.runtimeRoot, {
      threadUpdateBus: this.threadUpdateBus,
      threadEntryBus: this.threadEntryBus,
      threadCompactionBus: this.threadCompactionBus,
      threadMemoryBus: this.threadMemoryBus,
    })
    this.runStore = new RunStore(this.index, this.conversationStore, this.sessionStore, {
      runBus: this.runBus,
      eventBus: this.eventBus,
      itemBus: this.itemBus,
    })
    this.artifactStore = new ArtifactStore(this.index, this.conversationStore, new ArtifactIndexStore(db))
    this.objectStore = new ConversationObjectStore(this.conversationStore)
    this.meteorologicalDatasetStore = new MeteorologicalDatasetStore(db)
    this.runtimeConfigStore = new RuntimeConfigStore(db)
    this.toolCatalogStore = new ToolCatalogStore(db)
  }

  // --- Sessions ---

  async initialize(): Promise<void> {
    // manifest 是轻量索引；消息、事件和工具结果按 thread/run 文件延迟读取。
    const snapshot = await this.conversationStore.initialize()
    this.index.load(snapshot)
    await this.artifactStore.hydrateIndexForRuns(snapshot.runs)
    for (const session of this.sessionStore.values()) {
      if (session.latestThreadId && !this.index.hasThread(session.latestThreadId)) {
        await this.sessionStore.update(session.id, {
          latestThreadId: this.listThreadsForSession(session.id)[0]?.id ?? null,
        })
      }
    }
  }

  async createSession(owner?: ResourceOwner | null): Promise<SessionRecord> {
    return this.sessionStore.create(owner)
  }

  async getOrCreateUserDefaultSession(owner: ResourceOwner): Promise<SessionRecord> {
    return this.sessionStore.getOrCreateUserDefault(owner)
  }

  async getOrCreateDefaultSession(): Promise<SessionRecord> {
    return this.sessionStore.getOrCreateDefault()
  }

  getSession(sessionId: string): SessionRecord {
    return this.sessionStore.get(sessionId)
  }

  async updateSession(sessionId: string, fields: Partial<SessionRecord>): Promise<SessionRecord> {
    return this.sessionStore.update(sessionId, fields)
  }

  async getRuntimeConfig(configKey: string): Promise<Record<string, unknown> | null> {
    return this.runtimeConfigStore.get(configKey)
  }

  async upsertRuntimeConfig(configKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.runtimeConfigStore.upsert(configKey, payload)
  }

  async listToolCatalogEntries(): Promise<ToolCatalogEntry[]> {
    return this.toolCatalogStore.list()
  }

  async upsertToolCatalogEntry(entry: ToolCatalogEntry): Promise<ToolCatalogEntry> {
    return this.toolCatalogStore.upsert(entry)
  }

  async deleteToolCatalogEntry(toolKind: string, toolName: string): Promise<void> {
    await this.toolCatalogStore.delete(toolKind, toolName)
  }

  async listMeteorologicalDatasets(filters: {
    sessionId?: string | null
    threadId?: string | null
    filename?: string | null
    workspaceId?: string | null
    limit?: number
  } = {}): Promise<MeteorologicalDatasetRecord[]> {
    return this.meteorologicalDatasetStore.list(filters)
  }

  async resolveMeteorologicalDataset(filters: {
    sessionId: string
    threadId?: string | null
    datasetId?: string | null
    filename?: string | null
    workspaceId?: string | null
  }): Promise<MeteorologicalDatasetRecord | null> {
    return this.meteorologicalDatasetStore.resolve(filters)
  }

  async getMeteorologicalDataset(datasetId: string): Promise<MeteorologicalDatasetRecord | null> {
    return this.meteorologicalDatasetStore.get(datasetId)
  }

  async createMeteorologicalDataset(dataset: MeteorologicalDatasetRecord): Promise<void> {
    await this.meteorologicalDatasetStore.create(dataset)
  }

  async getMeteorologicalJob(jobId: string): Promise<MeteorologicalJobRecord | null> {
    return this.meteorologicalDatasetStore.getJob(jobId)
  }

  async createMeteorologicalJob(job: MeteorologicalJobRecord): Promise<void> {
    await this.meteorologicalDatasetStore.createJob(job)
  }

  async persistArtifact(artifact: ArtifactRef): Promise<void> {
    await this.artifactStore.persist(artifact)
  }

  // --- Threads ---

  listThreadsForSession(sessionId: string): AgentThreadRecord[] {
    return this.threadStore.listForSession(sessionId)
  }

  async createThread(sessionId: string, title?: string | null): Promise<AgentThreadRecord> {
    return this.threadStore.create(sessionId, title)
  }

  getThread(threadId: string): AgentThreadRecord {
    return this.threadStore.get(threadId)
  }

  async updateThread(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    return this.threadStore.update(threadId, fields)
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.threadStore.delete(threadId)
  }

  // --- Runs ---

  listRunsForSession(sessionId: string): AnalysisRun[] {
    return this.runStore.listForSession(sessionId)
  }

  listRunsForThread(threadId: string): AnalysisRun[] {
    return this.runStore.listForThread(threadId)
  }

  listRunSummaries(options: {
    sessionId: string
    threadId?: string | null
    cursor?: string | null
    limit?: number
  }): { items: RunSummary[]; nextCursor: string | null } {
    return this.runStore.listSummaries(options)
  }

  getRun(runId: string): AnalysisRun {
    return this.runStore.get(runId)
  }

  async createRun(sessionId: string, query: string, opts?: {
    threadId?: string | null; modelProvider?: string | null; modelName?: string | null
    runtimeConfigSnapshot?: AgentRuntimeConfig | null
  }): Promise<AnalysisRun> {
    return this.runStore.create(sessionId, query, opts)
  }

  async updateRunState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun> {
    return this.runStore.updateState(runId, updates)
  }

  async updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun> {
    return this.runStore.updateStatus(runId, status)
  }

  async completeRun(runId: string, status: string): Promise<AnalysisRun> {
    return this.runStore.complete(runId, status)
  }

  // --- conversationStore 窄封装 ---
  //
  // agent runtime、toolExecutionCoordinator、contextManager、resultPersistence
  // 只应通过这些封装方法访问底层文件事实源；它们不应直接引用 conversationStore。
  // 具体资源写入由 SessionStore / ThreadStore / RunStore 拥有，facade 只保留跨域组合 API。

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    await this.runStore.saveCheckpoint(runId, fields)
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.runStore.getCheckpoint(runId)
  }

  async appendAgentTranscript(
    runId: string,
    agentId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await this.runStore.appendAgentTranscript(runId, agentId, record)
  }

  async saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: { agentsSdkVersion: string; runtimeConfigDigest: string },
  ): Promise<void> {
    await this.runStore.saveAgentsSdkState(runId, serializedState, metadata)
  }

  async readAgentsSdkState(runId: string): Promise<string> {
    return this.runStore.readAgentsSdkState(runId)
  }

  async putConversationObject(
    content: string | Uint8Array,
    mediaType = 'application/octet-stream',
  ): Promise<ContentRef> {
    return this.objectStore.put(content, mediaType)
  }

  async readConversationObject(reference: ContentRef): Promise<Uint8Array> {
    return this.objectStore.read(reference)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    await this.runStore.appendToolValue(runId, value)
  }

  async flushConversationStore(): Promise<void> {
    await this.objectStore.flush()
  }

  getConversationStoreRoot(): string {
    return this.conversationStoreRoot
  }

  // --- Events & Items ---

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    await this.runStore.appendEvent(runId, event)
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.runStore.listEvents(runId)
  }

  async appendItem(item: ConversationItem): Promise<void> {
    await this.runStore.appendItem(item)
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    return this.runStore.listItems(runId)
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    return this.threadStore.getManifest(threadId)
  }

  async listThreadHistory(threadId: string, cursor?: string | null, limit?: number) {
    return this.threadStore.listHistory(threadId, cursor, limit)
  }

  async activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    return this.threadStore.activeTranscript(threadId, leafEntryId)
  }

  async appendTranscript(input: {
    threadId: string
    runId?: string | null
    turnId?: string | null
    kind: TranscriptEntryKind
    payload?: Record<string, unknown>
    parentEntryId?: string | null
    logicalParentEntryId?: string | null
    entryId?: string
  }): Promise<TranscriptEntry> {
    return this.threadStore.appendTranscript(input)
  }

  async forkThread(sourceThreadId: string, sourceEntryId: string, title?: string | null): Promise<AgentThreadRecord> {
    return this.threadStore.fork(sourceThreadId, sourceEntryId, title)
  }

  async getThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
    return this.threadStore.getMemory(threadId)
  }

  async updateThreadMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source: ThreadMemoryDocument['source'] = 'user',
    basedOnEntryId: string | null = null,
  ): Promise<ThreadMemoryDocument> {
    return this.threadStore.updateMemory(threadId, content, expectedVersion, source, basedOnEntryId)
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    await this.threadStore.appendCompaction(record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    return this.threadStore.listCompactions(threadId)
  }

  async listTrash(sessionId: string): Promise<TrashEntry[]> {
    return this.threadStore.listTrash(sessionId)
  }

  async getTrashedThread(threadId: string): Promise<AgentThreadRecord> {
    return this.threadStore.getTrashed(threadId)
  }

  async restoreThread(threadId: string): Promise<AgentThreadRecord> {
    return this.threadStore.restore(threadId)
  }

  async purgeThread(threadId: string): Promise<void> {
    await this.threadStore.purge(threadId)
  }

  async recordAttachment(threadId: string, input: {
    id: string
    name: string
    contentHash: string
    mediaType: string
    sizeBytes: number
    relativePath: string
  }, action: 'attached' | 'deleted' = 'attached'): Promise<void> {
    await this.threadStore.recordAttachment(threadId, input, action)
  }
}

