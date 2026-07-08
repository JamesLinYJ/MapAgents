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
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationIndexStore } from './conversationIndexStore.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { FileConversationStore, TrashEntry } from './fileConversationStore.js'
import { RuntimeFileStore } from './fileStore.js'
import { splitMemoryContent } from './platformStoreUtils.js'
import type { SessionStore } from './sessionStore.js'

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
    const manifest = await this.conversationStore.createThread(thread)
    this.index.setThread(thread)
    this.events.threadUpdateBus.publish(thread.id, { thread: structuredClone(thread), manifest })
    await this.sessionStore.update(sessionId, { latestThreadId: thread.id })
    return thread
  }

  get(threadId: string): AgentThreadRecord {
    return this.index.getThread(threadId)
  }

  async update(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    const next = { ...this.get(threadId), ...fields, updatedAt: nowUtc() }
    const manifest = await this.conversationStore.saveThread(next)
    if (next.status === 'deleted') this.index.deleteThread(threadId)
    else this.index.setThread(next)
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(next), manifest })
    return next
  }

  async delete(threadId: string): Promise<void> {
    const thread = this.get(threadId)
    const next = { ...thread, status: 'deleted' as const, updatedAt: nowUtc() }
    await this.conversationStore.saveThread(next)
    await this.conversationStore.moveThreadToTrash(threadId)
    this.index.deleteThread(threadId)
    const session = this.sessionStore.get(next.sessionId)
    if (session.latestThreadId === threadId) {
      const replacement = this.listForSession(next.sessionId)[0] ?? null
      await this.sessionStore.update(next.sessionId, { latestThreadId: replacement?.id ?? null })
    }
  }

  async getManifest(threadId: string): Promise<ThreadManifest> {
    this.get(threadId)
    return this.conversationStore.getThreadManifest(threadId)
  }

  async listHistory(threadId: string, cursor?: string | null, limit?: number) {
    this.get(threadId)
    return this.conversationStore.readHistory(threadId, cursor, limit)
  }

  async activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    this.get(threadId)
    return this.conversationStore.readActiveChain(threadId, leafEntryId)
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
    const entry = await this.conversationStore.appendTranscript(input)
    this.events.threadEntryBus.publish(input.threadId, entry)
    return entry
  }

  async fork(sourceThreadId: string, sourceEntryId: string, title?: string | null): Promise<AgentThreadRecord> {
    const source = this.get(sourceThreadId)
    const target = await this.create(source.sessionId, title ?? `${source.title} · 分支`)
    const targetManifest = await this.conversationStore.getThreadManifest(target.id)
    targetManifest.forkedFrom = { threadId: sourceThreadId, entryId: sourceEntryId }
    await this.conversationStore.saveThread(target, targetManifest)
    await this.conversationStore.forkTranscript(sourceThreadId, target.id, sourceEntryId)
    await new RuntimeFileStore(this.runtimeRoot).cloneThreadFiles(sourceThreadId, target.id)
    return target
  }

  async getMemory(threadId: string): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    return this.conversationStore.getMemory(threadId)
  }

  async updateMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source: ThreadMemoryDocument['source'] = 'user',
    basedOnEntryId: string | null = null,
  ): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    const { generatedContent, pinnedContent } = splitMemoryContent(content)
    const document = await this.conversationStore.saveMemory(threadId, {
      content,
      generatedContent,
      pinnedContent,
      source,
      basedOnEntryId,
    }, expectedVersion)
    this.events.threadMemoryBus.publish(threadId, document)
    return document
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    this.get(record.threadId)
    await this.conversationStore.appendCompaction(record)
    this.events.threadCompactionBus.publish(record.threadId, record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    this.get(threadId)
    return this.conversationStore.listCompactions(threadId)
  }

  async listTrash(sessionId: string): Promise<TrashEntry[]> {
    this.sessionStore.get(sessionId)
    return this.conversationStore.listTrash(sessionId)
  }

  async getTrashed(threadId: string): Promise<AgentThreadRecord> {
    const trashed = await this.conversationStore.getTrashedThread(threadId)
    return trashed.thread
  }

  async restore(threadId: string): Promise<AgentThreadRecord> {
    const restored = await this.conversationStore.restoreThread(threadId)
    const nextThread = { ...restored.thread, status: 'active' as const, updatedAt: nowUtc() }
    await this.conversationStore.saveThread(nextThread, restored.manifest)
    this.index.setThread(nextThread)
    this.index.rebuildDerivedIndexes()
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(nextThread), manifest: restored.manifest })
    return nextThread
  }

  async purge(threadId: string): Promise<void> {
    this.index.deleteRunsForThread(threadId)
    await this.conversationStore.purgeThread(threadId)
    await this.conversationStore.garbageCollectObjects()
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

