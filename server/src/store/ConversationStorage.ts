// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话存储接口 (Port/Adapter)
//
//   文件:       ConversationStorage.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// FileConversationStore 的存储后端抽象。当前实现为 JSONL 文件型，
// 未来 SQLite/其他实现只需满足此接口即可替换。
// 所有 write 操作隐式包含 journal → durable append 语义。

import type {
  AgentThreadRecord,
  AnalysisRun,
  ArtifactRef,
  CompactionRecord,
  ContentRef,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  SessionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  ToolValueRef,
  TranscriptEntry,
  TranscriptEntryKind,
} from '../schemas/types.js'

export interface ConversationSnapshot {
  sessions: SessionRecord[]
  threads: AgentThreadRecord[]
  runs: AnalysisRun[]
}

export interface ThreadHistoryPage {
  entries: TranscriptEntry[]
  nextCursor: string | null
}

export interface ConversationStorage {
  initialize(): Promise<ConversationSnapshot>

  // Session
  saveSession(session: SessionRecord): Promise<void>

  // Thread
  createThread(thread: AgentThreadRecord, forkedFrom?: ThreadManifest['forkedFrom'] | null): Promise<ThreadManifest>
  saveThread(thread: AgentThreadRecord, manifest?: ThreadManifest): Promise<ThreadManifest>
  getThreadManifest(threadId: string): Promise<ThreadManifest>

  // Run
  createRun(run: AnalysisRun): Promise<void>
  saveRun(
    run: AnalysisRun,
    fields?: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>
  saveAgentsSdkState(runId: string, serializedState: string, metadata: {
    agentsSdkVersion: string
    runtimeConfigDigest: string
  }): Promise<void>
  readAgentsSdkState(runId: string): Promise<string>
  appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void>

  // Transcript (journal-guaranteed)
  appendTranscript(input: {
    threadId: string; runId?: string | null; turnId?: string | null
    kind: TranscriptEntryKind; payload?: Record<string, unknown>
    parentEntryId?: string | null; logicalParentEntryId?: string | null
    entryId?: string
  }): Promise<TranscriptEntry>
  readHistory(threadId: string, cursor?: string | null, limit?: number): Promise<ThreadHistoryPage>
  readTranscript(threadId: string): Promise<TranscriptEntry[]>
  readActiveChain(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]>
  forkTranscript(sourceThreadId: string, targetThreadId: string, sourceEntryId: string): Promise<Map<string, string>>

  // Items / Events / Values (journal-guaranteed)
  appendItem(item: ConversationItem): Promise<void>
  appendEvent(event: RunEvent): Promise<void>
  listItems(runId: string): Promise<ConversationItem[]>
  listEvents(runId: string): Promise<RunEvent[]>
  appendValue(runId: string, value: ToolValueRef): Promise<void>

  // Artifacts / Attachments
  appendArtifact(runId: string, artifact: ArtifactRef): Promise<void>
  listArtifacts(runId: string): Promise<ArtifactRef[]>
  appendAttachment(threadId: string, record: {
    attachmentId: string
    action: 'attached' | 'deleted'
    name: string
    threadId: string
    contentRef: ContentRef | null
    createdAt: string
  }): Promise<void>

  // Compaction
  appendCompaction(record: CompactionRecord): Promise<void>
  listCompactions(threadId: string): Promise<CompactionRecord[]>

  // Memory
  getMemory(threadId: string): Promise<ThreadMemoryDocument>
  saveMemory(
    threadId: string,
    input: Pick<ThreadMemoryDocument, 'content' | 'generatedContent' | 'pinnedContent' | 'source' | 'basedOnEntryId'>,
    expectedVersion?: number,
  ): Promise<ThreadMemoryDocument>

  // Trash
  moveThreadToTrash(threadId: string, retentionDays?: number): Promise<unknown>
  listTrash(sessionId: string): Promise<unknown[]>
  getTrashedThread(threadId: string): Promise<unknown>
  restoreThread(threadId: string): Promise<unknown>
  purgeThread(threadId: string): Promise<void>
  purgeExpiredTrash(now?: Date): Promise<string[]>

  // Objects
  putObject(content: string | Uint8Array, mediaType?: string): Promise<ContentRef>
  readObject(reference: ContentRef): Promise<Uint8Array>

  // Management
  flush(): Promise<void>
  garbageCollectObjects(): Promise<unknown>
}
