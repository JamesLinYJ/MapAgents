// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程资源存储
//
//   文件:       threadStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  CompactionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  TranscriptEntry,
  TranscriptEntryKind,
} from '../schemas/types.js'
import { threadMemoryDocumentSchema } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationIndexStore } from './conversationIndexStore.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { FileConversationStore } from './fileConversationStore.js'
import { estimateTokens } from './fileConversationIo.js'
import { RuntimeFileStore } from './fileStore.js'
import { splitMemoryContent } from './platformStoreUtils.js'
import type { SessionStore } from './sessionStore.js'
import type { ConversationRepository, DeletedThreadRecord } from './postgres/conversationRepository.js'
import { MemoryVersionConflictError } from './storeErrors.js'

export interface ThreadStoreEvents {
  threadUpdateBus: InMemoryEventBus<{ thread: AgentThreadRecord; manifest: ThreadManifest }>
  threadEntryBus: InMemoryEventBus<TranscriptEntry>
  threadCompactionBus: InMemoryEventBus<CompactionRecord>
  threadMemoryBus: InMemoryEventBus<ThreadMemoryDocument>
}

// ThreadStore 是线程 manifest、transcript、线程记忆和垃圾箱动作的唯一拥有者。
// Run 状态只通过 index 读取；不会在这里创建或完成 run。
export class ThreadStore {
  constructor(
    private readonly index: ConversationIndexStore,
    private readonly conversationStore: FileConversationStore,
    private readonly sessionStore: SessionStore,
    private readonly repository: ConversationRepository,
    private readonly runtimeRoot: string,
    private readonly events: ThreadStoreEvents,
  ) {}

  listForSession(sessionId: string): AgentThreadRecord[] {
    return this.index.listThreadsForSession(sessionId)
  }

  async create(sessionId: string, title?: string | null): Promise<AgentThreadRecord> {
    const session = this.sessionStore.get(sessionId)
    const now = nowUtc()
    const thread: AgentThreadRecord = {
      id: makeId('thread'),
      sessionId,
      title: title || '新对话',
      workspaceId: session.workspaceId,
      createdByUserId: session.createdByUserId,
      visibility: session.visibility,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      latestRunId: null,
      latestUserQuery: null,
      latestAssistantSummary: null,
      latestRunStatus: null,
      latestArtifactId: null,
      latestArtifactName: null,
      historyPreview: null,
      conversationPath: null,
    }
    const persisted = await this.repository.createThreadLifecycle(thread)
    this.conversationStore.registerThread(persisted.thread)
    this.sessionStore.acceptPersisted(persisted.session)
    this.index.setThread(persisted.thread)
    this.events.threadUpdateBus.publish(thread.id, {
      thread: structuredClone(persisted.thread),
      manifest: persisted.manifest,
    })
    return persisted.thread
  }

  get(threadId: string): AgentThreadRecord {
    return this.index.getThread(threadId)
  }

  async update(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    const current = this.get(threadId)
    if (fields.status !== undefined && fields.status !== current.status) {
      throw new Error('线程状态只能通过删除或恢复操作修改')
    }
    const next = { ...current, ...fields, updatedAt: nowUtc() }
    await this.repository.saveThread(next)
    const manifest = await this.repository.getThreadManifest(threadId)
    this.index.setThread(next)
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(next), manifest })
    return next
  }

  async delete(threadId: string): Promise<void> {
    const thread = this.get(threadId)
    const next = { ...thread, status: 'deleted' as const, updatedAt: nowUtc() }
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const replacement = this.listForSession(next.sessionId).find(candidate => candidate.id !== threadId) ?? null
    const persisted = await this.repository.trashThread(next, purgeAfter, replacement?.id ?? null)
    this.conversationStore.setThreadTrashed(threadId, true)
    this.index.deleteThread(threadId)
    this.sessionStore.acceptPersisted(persisted.session)
  }

  async getManifest(threadId: string): Promise<ThreadManifest> {
    this.get(threadId)
    return this.repository.getThreadManifest(threadId)
  }

  async listHistory(threadId: string, cursor?: string | null, limit?: number) {
    this.get(threadId)
    return this.repository.readThreadHistory(threadId, cursor, limit)
  }

  async activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    this.get(threadId)
    return this.repository.readActiveConversation(threadId, leafEntryId)
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
    this.get(input.threadId)
    const entry = await this.repository.appendConversationEntry(input)
    this.events.threadEntryBus.publish(input.threadId, entry)
    return entry
  }

  async fork(sourceThreadId: string, sourceEntryId: string, title?: string | null): Promise<AgentThreadRecord> {
    const source = this.get(sourceThreadId)
    const target = await this.create(source.sessionId, title ?? `${source.title} · 分支`)
    const mapping = await this.repository.forkConversation(sourceThreadId, target.id, sourceEntryId)
    await new RuntimeFileStore(this.runtimeRoot).cloneThreadFiles(sourceThreadId, target.id)
    const sourceMemory = await this.getMemory(sourceThreadId)
    if (sourceMemory.version > 0 || sourceMemory.content.trim()) {
      await this.updateMemory(
        target.id,
        sourceMemory.content,
        0,
        'fork',
        sourceMemory.basedOnEntryId ? mapping.get(sourceMemory.basedOnEntryId) ?? null : null,
      )
    }
    const targetManifest = await this.repository.getThreadManifest(target.id)
    this.events.threadUpdateBus.publish(target.id, { thread: structuredClone(target), manifest: targetManifest })
    return target
  }

  async getMemory(threadId: string): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    const reference = await this.repository.getLatestThreadMemoryVersion(threadId)
    if (!reference) {
      const manifest = await this.repository.getThreadManifest(threadId)
      return threadMemoryDocumentSchema.parse({
        threadId,
        version: 0,
        content: '',
        generatedContent: '',
        pinnedContent: '',
        source: 'system',
        basedOnEntryId: null,
        estimatedTokens: 0,
        updatedAt: manifest.updatedAt,
      })
    }
    const bytes = await this.conversationStore.readObjectByHash(reference.contentHash)
    const document = threadMemoryDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    if (document.threadId !== threadId || document.version !== reference.version) {
      throw new Error(`线程 '${threadId}' 的记忆对象与数据库版本不一致`)
    }
    return document
  }

  async updateMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source: ThreadMemoryDocument['source'] = 'user',
    basedOnEntryId: string | null = null,
  ): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    const manifest = await this.repository.getThreadManifest(threadId)
    if (expectedVersion !== undefined && expectedVersion !== manifest.memoryVersion) {
      throw new MemoryVersionConflictError(expectedVersion, manifest.memoryVersion)
    }
    const { generatedContent, pinnedContent } = splitMemoryContent(content)
    const document = threadMemoryDocumentSchema.parse({
      threadId,
      version: manifest.memoryVersion + 1,
      content,
      generatedContent,
      pinnedContent,
      source,
      basedOnEntryId,
      estimatedTokens: estimateTokens(content),
      updatedAt: nowUtc(),
    })
    const reference = await this.conversationStore.putObject(
      JSON.stringify(document),
      'application/vnd.geoforge.thread-memory+json',
    )
    await this.repository.saveThreadMemoryVersion({
      threadId,
      expectedVersion: manifest.memoryVersion,
      version: document.version,
      contentHash: reference.hash,
      source: document.source,
      basedOnEntryId: document.basedOnEntryId,
      estimatedTokens: document.estimatedTokens,
      createdAt: document.updatedAt,
    })
    this.events.threadMemoryBus.publish(threadId, document)
    return document
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    this.get(record.threadId)
    await this.repository.appendCompaction(record)
    this.events.threadCompactionBus.publish(record.threadId, record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    this.get(threadId)
    return this.repository.listCompactions(threadId)
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    this.sessionStore.get(sessionId)
    return this.repository.listTrash(sessionId)
  }

  async getTrashed(threadId: string): Promise<AgentThreadRecord> {
    const trashed = await this.repository.getTrashedThread(threadId)
    return trashed.thread
  }

  async restore(threadId: string): Promise<AgentThreadRecord> {
    const trashed = await this.repository.getTrashedThread(threadId)
    const restored = await this.repository.restoreThread(threadId, trashed.thread.sessionId)
    const nextThread = restored.thread
    this.conversationStore.setThreadTrashed(threadId, false)
    this.sessionStore.acceptPersisted(restored.session)
    this.index.setThread(nextThread)
    for (const run of await this.repository.listRunsForThread(threadId)) {
      this.index.setRun(run)
      this.conversationStore.registerRun(run)
    }
    this.index.rebuildDerivedIndexes()
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(nextThread), manifest: restored.manifest })
    return nextThread
  }

  async purge(threadId: string): Promise<void> {
    const trashed = await this.repository.getTrashedThread(threadId)
    const session = await this.repository.purgeThread(threadId, trashed.thread.sessionId)
    this.sessionStore.acceptPersisted(session)
    this.index.deleteRunsForThread(threadId)
    await this.conversationStore.purgeThreadPayload(threadId)
    const references = await this.repository.listReferencedObjectHashes()
    await this.conversationStore.garbageCollectObjects(references)
  }

  async recordAttachment(threadId: string, input: {
    id: string
    name: string
    contentHash: string
    mediaType: string
    sizeBytes: number
    relativePath: string
  }, action: 'attached' | 'deleted' = 'attached'): Promise<void> {
    this.get(threadId)
    await this.conversationStore.appendAttachment(threadId, {
      attachmentId: input.id,
      action,
      name: input.name,
      threadId,
      contentRef: action === 'attached' ? {
        algorithm: 'sha256',
        hash: input.contentHash,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        relativePath: input.relativePath,
      } : null,
      createdAt: nowUtc(),
    })
  }
}
