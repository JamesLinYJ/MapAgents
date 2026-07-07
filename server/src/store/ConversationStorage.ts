// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话存储接口 (Port/Adapter)
//
//   文件:       ConversationStorage.ts
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

// FileConversationStore 的存储后端抽象。当前实现为 JSONL 文件型，
// 未来 SQLite/其他实现只需满足此接口即可替换。
// 所有 write 操作隐式包含 journal → durable append 语义。

import type {
  AgentThreadRecord,
  AnalysisRun,
  CompactionRecord,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  SessionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  TranscriptEntry,
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
  saveRun(run: AnalysisRun): Promise<RunCheckpoint>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>

  // Transcript (journal-guaranteed)
  appendTranscript(input: {
    threadId: string; runId?: string | null; turnId?: string | null
    kind: TranscriptEntry['kind']; payload?: Record<string, unknown>
    parentEntryId?: string | null; logicalParentEntryId?: string | null
    thread?: AgentThreadRecord; manifest?: ThreadManifest
    supervisorRun?: AnalysisRun | null
  }): Promise<TranscriptEntry>
  readHistory(threadId: string, cursor?: string | null, limit?: number): Promise<ThreadHistoryPage>

  // Items / Events / Values (journal-guaranteed)
  appendItem(item: ConversationItem): Promise<void>
  appendEvent(event: RunEvent): Promise<void>
  appendValue(runId: string, value: { refId: string; kind: string; label: string; value: unknown; createdAt: string }): Promise<void>

  // Artifacts / Attachments
  appendArtifact(runId: string, artifact: { artifactId: string; runId: string; artifactType: string; name: string; uri: string }): Promise<void>
  appendAttachment(threadId: string, record: { attachmentId: string; action: 'attached' | 'deleted'; name: string; threadId: string; contentRef: unknown | null; createdAt: string }): Promise<void>

  // Compaction
  appendCompaction(record: CompactionRecord): Promise<void>

  // Memory
  saveMemory(document: ThreadMemoryDocument): Promise<ThreadMemoryDocument>

  // Trash
  moveThreadToTrash(threadId: string, retentionDays?: number): Promise<unknown>
  restoreThread(threadId: string): Promise<unknown>
  purgeThread(threadId: string): Promise<void>

  // Management
  flush(): Promise<void>
  garbageCollectObjects(): Promise<unknown>
}
