// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时文件存储端口
//
//   文件:       ConversationStorage.ts
//
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  AnalysisRun,
  ContentRef,
  SessionRecord,
} from '../schemas/types.js'

export interface ConversationStorageSnapshot {
  sessions: SessionRecord[]
  threads: AgentThreadRecord[]
  deletedThreads: Array<{ thread: AgentThreadRecord }>
  runs: AnalysisRun[]
}

export interface ConversationAttachmentRecord {
  attachmentId: string
  action: 'attached' | 'deleted'
  name: string
  threadId: string
  contentRef: ContentRef | null
  createdAt: string
}

// PostgreSQL 拥有结构化会话事实。这个端口只管理无法直接放入关系表的
// 内容对象、附件审计和 Agent 诊断文件，以及它们的物理生命周期。
export interface ConversationStorage {
  initialize(snapshot: ConversationStorageSnapshot): Promise<void>
  registerThread(thread: AgentThreadRecord, trashed?: boolean): void
  setThreadTrashed(threadId: string, trashed: boolean): void
  purgeThreadPayload(threadId: string): Promise<void>
  registerRun(run: AnalysisRun): void

  appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void>
  appendAttachment(threadId: string, record: ConversationAttachmentRecord): Promise<void>

  putObject(content: string | Uint8Array, mediaType?: string): Promise<ContentRef>
  readObject(reference: ContentRef): Promise<Uint8Array>
  readObjectByHash(hash: string): Promise<Uint8Array>
  garbageCollectObjects(databaseReferences?: Iterable<string>): Promise<{ removed: number; retained: number }>

  flush(): Promise<void>
  close(): Promise<void>
}
