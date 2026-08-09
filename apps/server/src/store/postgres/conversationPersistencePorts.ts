// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话持久化端口
//
//   文件:       conversationPersistencePorts.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  AnalysisRun,
  ArtifactRef,
  CompactionRecord,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  RunSteeringRecord,
  SessionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  ToolValueRef,
  TranscriptEntry,
  TranscriptEntryKind,
} from '../../schemas/types.js'

export interface ConversationSnapshot {
  sessions: SessionRecord[]
  threads: AgentThreadRecord[]
  deletedThreads: DeletedThreadRecord[]
  runs: AnalysisRun[]
}

export interface DeletedThreadRecord {
  thread: AgentThreadRecord
  manifest: ThreadManifest
  deletedAt: string
  purgeAfter: string
}

export interface ThreadMemoryVersionReference {
  threadId: string
  version: number
  contentHash: string
  source: ThreadMemoryDocument['source']
  basedOnEntryId: string | null
  estimatedTokens: number
  createdAt: string
}

export interface ThreadLifecycleResult {
  session: SessionRecord
  thread: AgentThreadRecord
  manifest: ThreadManifest
}

export interface RunLifecycleResult {
  session: SessionRecord
  thread: AgentThreadRecord | null
  run: AnalysisRun
}

export interface TrashThreadLifecycleResult {
  session: SessionRecord
  deleted: DeletedThreadRecord
}

export interface EnqueueRunInput {
  inputId: string
  entryId: string
  itemId: string
  runId: string
  content: string
}

export interface AppendConversationEntryInput {
  threadId: string
  runId?: string | null
  turnId?: string | null
  kind: TranscriptEntryKind
  payload?: Record<string, unknown>
  parentEntryId?: string | null
  logicalParentEntryId?: string | null
  entryId?: string
}

export interface ThreadHistoryPage {
  entries: TranscriptEntry[]
  nextCursor: string | null
}

export interface ConversationSnapshotRepository {
  loadSnapshot(): Promise<ConversationSnapshot>
}

export interface SessionRepository {
  saveSession(session: SessionRecord): Promise<void>
}

export interface ThreadLifecycleRepository {
  createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult>
  saveThread(thread: AgentThreadRecord): Promise<void>
  trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult>
  listTrash(sessionId: string): Promise<DeletedThreadRecord[]>
  getTrashedThread(threadId: string): Promise<DeletedThreadRecord>
  restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult>
  purgeThread(threadId: string, sessionId: string): Promise<SessionRecord>
  getThreadManifest(threadId: string): Promise<ThreadManifest>
}

export interface ThreadMemoryRepository {
  saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference>
  getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null>
}

export interface ThreadCompactionRepository {
  appendCompaction(record: CompactionRecord): Promise<void>
  listCompactions(threadId: string): Promise<CompactionRecord[]>
}

export interface ConversationTranscriptRepository {
  appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry>
  readThreadHistory(threadId: string, cursor?: string | null, limit?: number): Promise<ThreadHistoryPage>
  readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]>
  forkConversation(sourceThreadId: string, targetThreadId: string, sourceEntryId: string): Promise<Map<string, string>>
}

export interface ThreadRepository extends
  ThreadLifecycleRepository,
  ThreadMemoryRepository,
  ThreadCompactionRepository,
  ConversationTranscriptRepository {}

export interface RunStateRepository {
  createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult>
  saveRun(run: AnalysisRun): Promise<void>
  saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  listRunsForThread(threadId: string): Promise<AnalysisRun[]>
}

export interface RunCheckpointRepository {
  saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>
  saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
    inputLeaseId?: string | null
    terminalToolCallIds?: readonly string[]
  }): Promise<RunSteeringRecord[]>
}

export interface RunRecordRepository {
  appendConversationItem(item: ConversationItem): Promise<void>
  listConversationItems(runId: string): Promise<ConversationItem[]>
  appendRunEvent(event: RunEvent): Promise<void>
  listRunEvents(runId: string): Promise<RunEvent[]>
  appendToolValue(runId: string, value: ToolValueRef): Promise<void>
  listToolValues(runId: string): Promise<ToolValueRef[]>
}

export interface RunRepository extends
  RunStateRepository,
  RunCheckpointRepository,
  RunRecordRepository {}

export interface ToolResultCommitter {
  commitToolResult(
    run: AnalysisRun,
    resultId: string,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<boolean>
}

export interface ObjectReferenceRepository {
  listReferencedObjectHashes(): Promise<string[]>
}

export interface RunInputRepository {
  enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord>
  getRunInput(runId: string, inputId: string): Promise<RunSteeringRecord | null>
  leaseRunInputs(runId: string, leaseId: string): Promise<RunSteeringRecord[]>
  requeueLeasedRunInputs(runId: string): Promise<RunSteeringRecord[]>
  listRunInputs(runId: string): Promise<RunSteeringRecord[]>
}

export interface ConversationPersistence extends
  ConversationSnapshotRepository,
  SessionRepository,
  ThreadRepository,
  RunRepository,
  ObjectReferenceRepository,
  RunInputRepository,
  ToolResultCommitter {}
