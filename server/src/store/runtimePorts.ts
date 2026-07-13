// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时持久化端口
//
//   文件:       runtimePorts.ts
// --------------------------------------------------------------------------

import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  CompactionRecord,
  ContentRef,
  ConversationItem,
  MeteorologicalDatasetRecord,
  RunCheckpoint,
  RunEvent,
  RunSteeringRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  ToolValueRef,
  TranscriptEntry,
  TranscriptEntryKind,
} from '../schemas/types.js'

export interface AppendTranscriptInput {
  threadId: string
  runId?: string | null
  turnId?: string | null
  kind: TranscriptEntryKind
  payload?: Record<string, unknown>
  parentEntryId?: string | null
  logicalParentEntryId?: string | null
  entryId?: string
}

export interface AgentRuntimeStore {
  readonly runtimeRoot: string
  getRun(runId: string): AnalysisRun
  listRunsForThread(threadId: string): AnalysisRun[]
  updateRunState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun>
  updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun>
  completeRun(runId: string, status: string): Promise<AnalysisRun>
  saveRunCheckpoint(
    runId: string,
    fields?: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void>
  getRunCheckpoint(runId: string): Promise<RunCheckpoint>
  appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void>
  saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: { agentsSdkVersion: string; runtimeConfigDigest: string },
  ): Promise<void>
  readAgentsSdkState(runId: string): Promise<string>
  appendEvent(runId: string, event: RunEvent): Promise<void>
  appendItem(item: ConversationItem): Promise<void>
  enqueueRunInput(input: {
    inputId: string
    entryId: string
    itemId: string
    runId: string
    content: string
  }): Promise<RunSteeringRecord>
  consumeRunInputs(runId: string): Promise<RunSteeringRecord[]>
  listRunInputs(runId: string): Promise<RunSteeringRecord[]>
  activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]>
  appendTranscript(input: AppendTranscriptInput): Promise<TranscriptEntry>
  getThreadManifest(threadId: string): Promise<ThreadManifest>
  getThreadMemory(threadId: string): Promise<ThreadMemoryDocument>
  updateThreadMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source?: ThreadMemoryDocument['source'],
    basedOnEntryId?: string | null,
  ): Promise<ThreadMemoryDocument>
  appendCompaction(record: CompactionRecord): Promise<void>
  putConversationObject(content: string | Uint8Array, mediaType?: string): Promise<ContentRef>
  readConversationObject(reference: ContentRef): Promise<Uint8Array>
  appendToolValue(runId: string, value: ToolValueRef): Promise<void>
  persistArtifact(artifact: ArtifactRef): Promise<void>
  resolveMeteorologicalDataset(filters: {
    sessionId: string
    threadId?: string | null
    datasetId?: string | null
    filename?: string | null
    workspaceId?: string | null
  }): Promise<MeteorologicalDatasetRecord | null>
}

export type RunLookupStore = Pick<AgentRuntimeStore, 'getRun'>

export type ThreadContextStore = Pick<AgentRuntimeStore,
  | 'runtimeRoot'
  | 'activeTranscript'
  | 'appendCompaction'
  | 'appendTranscript'
  | 'getThreadManifest'
  | 'getThreadMemory'
  | 'listRunsForThread'
  | 'readConversationObject'
  | 'updateThreadMemory'
>

export type MemoryConversationStore = Pick<AgentRuntimeStore,
  | 'activeTranscript'
  | 'getRun'
  | 'getThreadManifest'
  | 'getThreadMemory'
  | 'updateThreadMemory'
>

export type ToolExecutionStore = Pick<AgentRuntimeStore,
  | 'activeTranscript'
  | 'appendToolValue'
  | 'appendTranscript'
  | 'getRun'
  | 'persistArtifact'
  | 'putConversationObject'
  | 'resolveMeteorologicalDataset'
  | 'runtimeRoot'
  | 'saveRunCheckpoint'
  | 'updateRunState'
>

export type DeterministicNowcastStore = Pick<AgentRuntimeStore,
  'appendTranscript' | 'runtimeRoot'
>
