// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件型会话事实源
//
//   文件:       fileConversationStore.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  artifactRefSchema,
  compactionRecordSchema,
  conversationItemSchema,
  runCheckpointSchema,
  runEventSchema,
  sessionRecordSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type AnalysisRun,
  type ArtifactRef,
  type CompactionRecord,
  type ContentRef,
  type ConversationItem,
  type RunCheckpoint,
  type RunEvent,
  type SessionRecord,
  type ThreadManifest,
  type ThreadMemoryDocument,
  type ToolValueRef,
  type TranscriptEntry,
  type TranscriptEntryKind,
} from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { z } from 'zod'
import {
  appendJsonLineDurable,
  atomicWriteJson,
  atomicWriteText,
  decodeCursor,
  encodeCursor,
  estimateTokens,
  isRecord,
  jsonLinesContainId,
  listDirectories,
  listFileNames,
  listFilesRecursively,
  readJson,
  readRawJson,
  recordJsonLineCorruption,
  safeId,
  stringField,
} from './fileConversationIo.js'

const STORE_SCHEMA_VERSION = 2
const DEFAULT_TRASH_RETENTION_DAYS = 30

interface ThreadFile {
  thread: AgentThreadRecord
  manifest: ThreadManifest
}

interface ThreadLocation {
  sessionId: string
  directory: string
  trashed: boolean
}

interface RunLocation {
  sessionId: string
  threadId: string
  directory: string
}

const threadJournalSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  operationId: z.string(),
  type: z.literal('appendTranscript'),
  entry: transcriptEntrySchema,
  threadFile: z.object({
    thread: z.custom<AgentThreadRecord>(value => typeof value === 'object' && value !== null),
    manifest: threadManifestSchema,
  }),
  supervisorTranscriptPath: z.string().nullable(),
  createdAt: z.string(),
})

type ThreadJournal = z.infer<typeof threadJournalSchema>

export interface ConversationStoreSnapshot {
  sessions: SessionRecord[]
  threads: AgentThreadRecord[]
  runs: AnalysisRun[]
}

export interface ThreadHistoryPage {
  entries: TranscriptEntry[]
  nextCursor: string | null
}

export interface TrashEntry {
  thread: AgentThreadRecord
  manifest: ThreadManifest
  deletedAt: string
  purgeAfter: string
}

export interface AttachmentRecord {
  attachmentId: string
  action: 'attached' | 'deleted'
  name: string
  threadId: string
  contentRef: ContentRef | null
  createdAt: string
}

export class ConversationCorruptionError extends Error {
  constructor(
    message: string,
    readonly threadId: string,
    readonly filePath: string,
  ) {
    super(message)
    this.name = 'ConversationCorruptionError'
  }
}

// FileConversationStore
//
// JSON/JSONL/Markdown 文件是会话事实源；内存映射只保存定位信息，不缓存完整历史。
export class FileConversationStore {
  readonly root: string
  readonly sessionsRoot: string
  readonly objectsRoot: string

  private threadLocations = new Map<string, ThreadLocation>()
  private runLocations = new Map<string, RunLocation>()
  private writeQueues = new Map<string, Promise<void>>()
  private threadQueues = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = path.resolve(root)
    this.sessionsRoot = path.join(this.root, 'sessions')
    const runtimeRoot = ['sessions', 'conversations'].includes(path.basename(this.root))
      ? path.dirname(this.root)
      : this.root
    this.objectsRoot = path.join(runtimeRoot, 'objects', 'sha256')
  }

  async initialize(): Promise<ConversationStoreSnapshot> {
    await mkdir(this.sessionsRoot, { recursive: true })
    await mkdir(this.objectsRoot, { recursive: true })
    await this.ensureStoreManifest()

    this.threadLocations.clear()
    this.runLocations.clear()
    const sessions: SessionRecord[] = []
    const threads: AgentThreadRecord[] = []
    const runs: AnalysisRun[] = []

    for (const sessionDir of await listDirectories(this.sessionsRoot)) {
      const sessionId = safeId(sessionDir, 'sessionId')
      const session = await readJson(path.join(this.sessionsRoot, sessionId, 'session.json'), sessionRecordSchema)
      if (!session) continue
      sessions.push(session)
      const threadRoot = path.join(this.sessionsRoot, sessionId, 'threads')
      for (const threadId of await listDirectories(threadRoot)) {
        const loaded = await this.loadThreadDirectory(sessionId, threadId, false)
        if (!loaded) continue
        threads.push(loaded.thread)
        runs.push(...await this.loadRuns(sessionId, threadId, loaded.directory))
      }
      const trashRoot = path.join(this.sessionsRoot, sessionId, 'trash')
      for (const threadId of await listDirectories(trashRoot)) {
        const loaded = await this.loadThreadDirectory(sessionId, threadId, true)
        if (!loaded) continue
        await this.loadRuns(sessionId, threadId, loaded.directory)
      }
    }

    const expired = await this.purgeExpiredTrash()
    if (expired.length) await this.garbageCollectObjects()
    return { sessions, threads, runs }
  }

  async saveSession(session: SessionRecord): Promise<void> {
    const sessionId = safeId(session.id, 'sessionId')
    const directory = path.join(this.sessionsRoot, sessionId)
    await mkdir(path.join(directory, 'threads'), { recursive: true })
    await mkdir(path.join(directory, 'trash'), { recursive: true })
    await atomicWriteJson(path.join(directory, 'session.json'), session)
  }

  async createThread(thread: AgentThreadRecord, forkedFrom: ThreadManifest['forkedFrom'] = null): Promise<ThreadManifest> {
    const sessionId = safeId(thread.sessionId, 'sessionId')
    const threadId = safeId(thread.id, 'threadId')
    const directory = this.threadDirectory(sessionId, threadId)
    const manifest: ThreadManifest = {
      schemaVersion: STORE_SCHEMA_VERSION,
      threadId,
      sessionId,
      activeLeafEntryId: null,
      lastSequence: 0,
      transcriptEntryCount: 0,
      estimatedContextTokens: 0,
      latestCompactionId: null,
      memoryVersion: 0,
      memoryBasedOnTokens: 0,
      forkedFrom,
      quarantined: false,
      quarantineReason: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }
    await mkdir(path.join(directory, 'runs'), { recursive: true })
    await mkdir(path.join(directory, 'memory'), { recursive: true })
    await atomicWriteJson(path.join(directory, 'thread.json'), { thread, manifest })
    this.threadLocations.set(threadId, { sessionId, directory, trashed: false })
    return manifest
  }

  async saveThread(thread: AgentThreadRecord, manifest?: ThreadManifest): Promise<ThreadManifest> {
    const location = this.requireThreadLocation(thread.id)
    return this.withThreadLock(thread.id, async () => {
      const existing = await this.readThreadFile(location.directory)
      const nextManifest = manifest ?? existing.manifest
      nextManifest.updatedAt = thread.updatedAt
      await atomicWriteJson(path.join(location.directory, 'thread.json'), { thread, manifest: nextManifest })
      return nextManifest
    })
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    const location = this.requireThreadLocation(threadId)
    return (await this.readThreadFile(location.directory)).manifest
  }

  async createRun(run: AnalysisRun): Promise<void> {
    if (!run.threadId) throw new Error('文件型会话中的 run 必须属于 thread')
    const thread = this.requireThreadLocation(run.threadId)
    if (thread.trashed) throw new Error(`线程 '${run.threadId}' 已在回收站`)
    const directory = path.join(thread.directory, 'runs', safeId(run.id, 'runId'))
    const supervisorDirectory = path.join(directory, 'agents', 'supervisor')
    await mkdir(supervisorDirectory, { recursive: true })
    const checkpoint: RunCheckpoint = {
      schemaVersion: STORE_SCHEMA_VERSION,
      run,
      activeEntryId: null,
      pendingToolCallIds: [],
      lastPersistedAt: nowUtc(),
      recoveryStatus: 'clean',
      orchestrationEngine: null,
      agentsSdkVersion: null,
      runtimeConfigDigest: null,
      sdkStateSchemaVersion: null,
      sdkStateUpdatedAt: null,
    }
    await atomicWriteJson(path.join(directory, 'run.json'), checkpoint)
    await atomicWriteJson(path.join(supervisorDirectory, 'agent.json'), {
      schemaVersion: STORE_SCHEMA_VERSION,
      agentId: 'supervisor',
      role: 'supervisor',
      runId: run.id,
      status: 'active',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })
    this.runLocations.set(run.id, {
      sessionId: run.sessionId,
      threadId: run.threadId,
      directory,
    })
  }

  async saveRun(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    const location = this.requireRunLocation(run.id)
    await this.withThreadLock(location.threadId, async () => {
      const current = await readJson(path.join(location.directory, 'run.json'), runCheckpointSchema)
      const checkpoint: RunCheckpoint = {
        schemaVersion: STORE_SCHEMA_VERSION,
        run,
        activeEntryId: fields.activeEntryId ?? current?.activeEntryId ?? null,
        pendingToolCallIds: fields.pendingToolCallIds ?? current?.pendingToolCallIds ?? [],
        recoveryStatus: fields.recoveryStatus ?? current?.recoveryStatus ?? 'clean',
        lastPersistedAt: nowUtc(),
        orchestrationEngine: current?.orchestrationEngine ?? null,
        agentsSdkVersion: current?.agentsSdkVersion ?? null,
        runtimeConfigDigest: current?.runtimeConfigDigest ?? null,
        sdkStateSchemaVersion: current?.sdkStateSchemaVersion ?? null,
        sdkStateUpdatedAt: current?.sdkStateUpdatedAt ?? null,
      }
      await atomicWriteJson(path.join(location.directory, 'run.json'), checkpoint)
      await atomicWriteJson(path.join(location.directory, 'agents', 'supervisor', 'agent.json'), {
        schemaVersion: STORE_SCHEMA_VERSION,
        agentId: 'supervisor',
        role: 'supervisor',
        runId: run.id,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })
    })
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    const location = this.requireRunLocation(runId)
    const checkpoint = await readJson(path.join(location.directory, 'run.json'), runCheckpointSchema)
    if (!checkpoint) throw new Error(`run '${runId}' 检查点不存在`)
    return checkpoint
  }

  // saveAgentsSdkState
  //
  // SDK RunState 与 run.json 分开原子写入；检查点只保存恢复所需的版本与配置摘要。
  async saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: { agentsSdkVersion: string; runtimeConfigDigest: string },
  ): Promise<void> {
    const location = this.requireRunLocation(runId)
    await this.withThreadLock(location.threadId, async () => {
      const statePath = path.join(location.directory, 'agents', 'supervisor', 'sdk-state.json')
      await atomicWriteText(statePath, `${serializedState.trim()}\n`)
      const checkpointPath = path.join(location.directory, 'run.json')
      const checkpoint = await readJson(checkpointPath, runCheckpointSchema)
      if (!checkpoint) throw new Error(`run '${runId}' 检查点不存在`)
      const updatedAt = nowUtc()
      await atomicWriteJson(checkpointPath, {
        ...checkpoint,
        orchestrationEngine: 'openai_agents',
        agentsSdkVersion: metadata.agentsSdkVersion,
        runtimeConfigDigest: metadata.runtimeConfigDigest,
        sdkStateSchemaVersion: 2,
        sdkStateUpdatedAt: updatedAt,
        lastPersistedAt: updatedAt,
      } satisfies RunCheckpoint)
    })
  }

  async readAgentsSdkState(runId: string): Promise<string> {
    const location = this.requireRunLocation(runId)
    const statePath = path.join(location.directory, 'agents', 'supervisor', 'sdk-state.json')
    try {
      return await readFile(statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`run '${runId}' 缺少 Agents SDK 状态，不能恢复`)
      }
      throw error
    }
  }

  appendItem(item: ConversationItem): Promise<void> {
    const location = this.requireRunLocation(item.runId)
    return this.enqueueAppend(path.join(location.directory, 'items.jsonl'), conversationItemSchema.parse(item))
  }

  appendEvent(event: RunEvent): Promise<void> {
    const location = this.requireRunLocation(event.runId)
    return this.enqueueAppend(path.join(location.directory, 'events.jsonl'), runEventSchema.parse(event))
  }

  async appendAgentTranscript(
    runId: string,
    agentId: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    const location = this.requireRunLocation(runId)
    const safeAgentId = safeId(agentId, 'agentId')
    const directory = path.join(location.directory, 'agents', safeAgentId)
    await mkdir(directory, { recursive: true })
    const agentPath = path.join(directory, 'agent.json')
    if (!await readRawJson(agentPath)) {
      const timestamp = nowUtc()
      await atomicWriteJson(agentPath, {
        schemaVersion: STORE_SCHEMA_VERSION,
        agentId: safeAgentId,
        role: safeAgentId,
        runId,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    await this.enqueueAppend(path.join(directory, 'transcript.jsonl'), {
      schemaVersion: STORE_SCHEMA_VERSION,
      timestamp: nowUtc(),
      ...record,
    })
  }

  appendValue(runId: string, value: ToolValueRef): Promise<void> {
    const location = this.requireRunLocation(runId)
    return this.enqueueAppend(path.join(location.directory, 'values.jsonl'), value)
  }

  async appendArtifact(runId: string, artifact: ArtifactRef): Promise<void> {
    const location = this.requireRunLocation(runId)
    await this.enqueueAppendAndWait(path.join(location.directory, 'artifacts.jsonl'), artifactRefSchema.parse(artifact))
  }

  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    const location = this.requireRunLocation(runId)
    return this.readJsonLines(path.join(location.directory, 'artifacts.jsonl'), location.threadId, artifactRefSchema)
  }

  async appendAttachment(threadId: string, record: AttachmentRecord): Promise<void> {
    const location = this.requireThreadLocation(threadId)
    if (location.trashed) throw new Error(`线程 '${threadId}' 已在回收站`)
    await this.enqueueAppendAndWait(path.join(location.directory, 'attachments.jsonl'), record)
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    const location = this.requireRunLocation(runId)
    const records = await this.readJsonLines(path.join(location.directory, 'items.jsonl'), location.threadId, conversationItemSchema)
    const latest = new Map(records.map(item => [item.itemId, item]))
    return [...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const location = this.requireRunLocation(runId)
    return this.readJsonLines(path.join(location.directory, 'events.jsonl'), location.threadId, runEventSchema)
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
    const location = this.requireThreadLocation(input.threadId)
    if (location.trashed) throw new Error(`线程 '${input.threadId}' 已在回收站`)
    return this.withThreadLock(input.threadId, async () => {
      const current = await this.readThreadFile(location.directory)
      if (current.manifest.quarantined) throw new Error(`线程已隔离：${current.manifest.quarantineReason ?? '存储损坏'}`)
      const entry: TranscriptEntry = transcriptEntrySchema.parse({
        schemaVersion: STORE_SCHEMA_VERSION,
        seq: current.manifest.lastSequence + 1,
        entryId: input.entryId ?? makeId('entry'),
        parentEntryId: input.parentEntryId === undefined
          ? current.manifest.activeLeafEntryId
          : input.parentEntryId,
        logicalParentEntryId: input.logicalParentEntryId ?? null,
        threadId: input.threadId,
        runId: input.runId ?? null,
        turnId: input.turnId ?? null,
        kind: input.kind,
        timestamp: nowUtc(),
        payload: input.payload ?? {},
      })
      const updatedThreadFile = structuredClone(current)
      updatedThreadFile.manifest.activeLeafEntryId = entry.entryId
      updatedThreadFile.manifest.lastSequence = entry.seq
      updatedThreadFile.manifest.transcriptEntryCount += 1
      updatedThreadFile.manifest.estimatedContextTokens += estimateTokens(JSON.stringify(entry.payload))
      updatedThreadFile.manifest.updatedAt = entry.timestamp
      updatedThreadFile.thread.updatedAt = entry.timestamp
      const supervisorTranscriptPath = entry.runId && this.runLocations.get(entry.runId)
        ? path.join(this.runLocations.get(entry.runId)!.directory, 'agents', 'supervisor', 'transcript.jsonl')
        : null
      const journal: ThreadJournal = {
        schemaVersion: STORE_SCHEMA_VERSION,
        operationId: makeId('journal'),
        type: 'appendTranscript',
        entry,
        threadFile: updatedThreadFile,
        supervisorTranscriptPath,
        createdAt: nowUtc(),
      }
      const journalPath = await this.writeThreadJournal(location.directory, journal)
      await this.applyThreadJournal(location.directory, journal, journalPath)
      return entry
    })
  }

  private async writeThreadJournal(directory: string, journal: ThreadJournal): Promise<string> {
    const journalDirectory = path.join(directory, 'journals')
    await mkdir(journalDirectory, { recursive: true })
    const journalPath = path.join(journalDirectory, `${safeId(journal.operationId, 'journalId')}.json`)
    await atomicWriteJson(journalPath, journal)
    return journalPath
  }

  private async applyThreadJournal(directory: string, journal: ThreadJournal, journalPath?: string): Promise<void> {
    if (journal.type !== 'appendTranscript') return
    const transcriptPath = path.join(directory, 'transcript.jsonl')
    if (!await jsonLinesContainId(transcriptPath, 'entryId', journal.entry.entryId)) {
      await appendJsonLineDurable(transcriptPath, journal.entry)
    }
    if (journal.supervisorTranscriptPath && !await jsonLinesContainId(journal.supervisorTranscriptPath, 'entryId', journal.entry.entryId)) {
      await appendJsonLineDurable(journal.supervisorTranscriptPath, journal.entry)
    }
    await atomicWriteJson(path.join(directory, 'thread.json'), journal.threadFile)
    if (journalPath) await rm(journalPath, { force: true })
  }

  private async recoverThreadJournals(directory: string): Promise<void> {
    const journalDirectory = path.join(directory, 'journals')
    for (const fileName of await listFileNames(journalDirectory)) {
      if (!fileName.endsWith('.json')) continue
      const journalPath = path.join(journalDirectory, fileName)
      const raw = await readRawJson(journalPath)
      if (!raw) {
        await rm(journalPath, { force: true })
        continue
      }
      const parsed = threadJournalSchema.parse(raw)
      await this.applyThreadJournal(directory, parsed, journalPath)
    }
  }

  async readHistory(threadId: string, cursor?: string | null, limit = 100): Promise<ThreadHistoryPage> {
    // 压缩重放副本只服务于模型上下文，历史 UI 始终展示原始消息一次。
    const entries = (await this.readTranscript(threadId)).filter(entry => entry.payload.compactionReplay !== true)
    const before = cursor ? decodeCursor(cursor) : Number.POSITIVE_INFINITY
    const eligible = entries.filter(entry => entry.seq < before).sort((left, right) => right.seq - left.seq)
    const page = eligible.slice(0, Math.min(200, Math.max(1, limit)))
    const nextCursor = eligible.length > page.length && page.length
      ? encodeCursor(page[page.length - 1].seq)
      : null
    return { entries: page.reverse(), nextCursor }
  }

  async readTranscript(threadId: string): Promise<TranscriptEntry[]> {
    const location = this.requireThreadLocation(threadId)
    try {
      return await this.readJsonLines(path.join(location.directory, 'transcript.jsonl'), threadId, transcriptEntrySchema)
    } catch (error) {
      if (error instanceof ConversationCorruptionError) await this.quarantineThread(threadId, error.message)
      throw error
    }
  }

  async readActiveChain(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    const entries = await this.readTranscript(threadId)
    if (!entries.length) return []
    const manifest = await this.getThreadManifest(threadId)
    const leaf = leafEntryId ?? manifest.activeLeafEntryId
    if (!leaf) return []
    const byId = new Map(entries.map(entry => [entry.entryId, entry]))
    const chain: TranscriptEntry[] = []
    const seen = new Set<string>()
    let current = byId.get(leaf)
    while (current) {
      if (seen.has(current.entryId)) throw new ConversationCorruptionError('transcript 父链存在循环', threadId, this.requireThreadLocation(threadId).directory)
      seen.add(current.entryId)
      chain.push(current)
      current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined
    }
    return chain.reverse()
  }

  async forkTranscript(sourceThreadId: string, targetThreadId: string, sourceEntryId: string): Promise<Map<string, string>> {
    const sourceChain = await this.readActiveChain(sourceThreadId, sourceEntryId)
    if (!sourceChain.length || sourceChain.at(-1)?.entryId !== sourceEntryId) {
      throw new Error(`分支源消息 '${sourceEntryId}' 不存在`)
    }
    const mapping = new Map<string, string>()
    for (const source of sourceChain) {
      const parentEntryId = source.parentEntryId ? mapping.get(source.parentEntryId) ?? null : null
      const copied = await this.appendTranscript({
        threadId: targetThreadId,
        runId: null,
        turnId: source.turnId,
        kind: source.kind,
        parentEntryId,
        logicalParentEntryId: null,
        payload: {
          ...source.payload,
          origin: { threadId: sourceThreadId, entryId: source.entryId },
        },
      })
      mapping.set(source.entryId, copied.entryId)
    }
    await this.copyOptionalFile(
      path.join(this.requireThreadLocation(sourceThreadId).directory, 'attachments.jsonl'),
      path.join(this.requireThreadLocation(targetThreadId).directory, 'attachments.jsonl'),
    )
    const sourceMemory = await this.getMemory(sourceThreadId)
    if (sourceMemory.version > 0 || sourceMemory.content.trim()) {
      await this.saveMemory(targetThreadId, {
        content: sourceMemory.content,
        generatedContent: sourceMemory.generatedContent,
        pinnedContent: sourceMemory.pinnedContent,
        source: 'fork',
        basedOnEntryId: mapping.get(sourceMemory.basedOnEntryId ?? '') ?? null,
      })
    }
    return mapping
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    const location = this.requireThreadLocation(record.threadId)
    await this.enqueueAppendAndWait(path.join(location.directory, 'compactions.jsonl'), compactionRecordSchema.parse(record))
    const current = await this.readThreadFile(location.directory)
    current.manifest.latestCompactionId = record.compactionId
    current.manifest.estimatedContextTokens = record.postTokens
    current.manifest.updatedAt = record.createdAt
    await atomicWriteJson(path.join(location.directory, 'thread.json'), current)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    const location = this.requireThreadLocation(threadId)
    return this.readJsonLines(path.join(location.directory, 'compactions.jsonl'), threadId, compactionRecordSchema)
  }

  async getMemory(threadId: string): Promise<ThreadMemoryDocument> {
    const location = this.requireThreadLocation(threadId)
    const versions = await this.readJsonLines(
      path.join(location.directory, 'memory', 'versions.jsonl'),
      threadId,
      threadMemoryDocumentSchema,
    )
    return versions.at(-1) ?? {
      threadId,
      version: 0,
      content: '',
      generatedContent: '',
      pinnedContent: '',
      source: 'system',
      basedOnEntryId: null,
      estimatedTokens: 0,
      updatedAt: nowUtc(),
    }
  }

  async saveMemory(
    threadId: string,
    input: Pick<ThreadMemoryDocument, 'content' | 'generatedContent' | 'pinnedContent' | 'source' | 'basedOnEntryId'>,
    expectedVersion?: number,
  ): Promise<ThreadMemoryDocument> {
    const location = this.requireThreadLocation(threadId)
    return this.withThreadLock(threadId, async () => {
      const current = await this.getMemory(threadId)
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new Error(`memory 版本冲突：期望 ${expectedVersion}，当前 ${current.version}`)
      }
      const document: ThreadMemoryDocument = {
        threadId,
        version: current.version + 1,
        content: input.content,
        generatedContent: input.generatedContent,
        pinnedContent: input.pinnedContent,
        source: input.source,
        basedOnEntryId: input.basedOnEntryId,
        estimatedTokens: estimateTokens(input.content),
        updatedAt: nowUtc(),
      }
      const memoryDir = path.join(location.directory, 'memory')
      await mkdir(memoryDir, { recursive: true })
      await appendJsonLineDurable(path.join(memoryDir, 'versions.jsonl'), document)
      await atomicWriteText(path.join(memoryDir, 'current.md'), document.content)
      const threadFile = await this.readThreadFile(location.directory)
      threadFile.manifest.memoryVersion = document.version
      threadFile.manifest.memoryBasedOnTokens = threadFile.manifest.estimatedContextTokens
      threadFile.manifest.updatedAt = document.updatedAt
      await atomicWriteJson(path.join(location.directory, 'thread.json'), threadFile)
      return document
    })
  }

  async moveThreadToTrash(threadId: string, retentionDays = DEFAULT_TRASH_RETENTION_DAYS): Promise<TrashEntry> {
    const location = this.requireThreadLocation(threadId)
    if (location.trashed) throw new Error(`线程 '${threadId}' 已在回收站`)
    const threadFile = await this.readThreadFile(location.directory)
    const target = path.join(this.sessionsRoot, location.sessionId, 'trash', safeId(threadId, 'threadId'))
    const deletedAt = nowUtc()
    const purgeAfter = new Date(Date.now() + retentionDays * 86_400_000).toISOString()
    await atomicWriteJson(path.join(location.directory, 'tombstone.json'), { threadId, deletedAt, purgeAfter })
    await mkdir(path.dirname(target), { recursive: true })
    await rename(location.directory, target)
    this.threadLocations.set(threadId, { ...location, directory: target, trashed: true })
    for (const [runId, run] of this.runLocations) {
      if (run.threadId === threadId) this.runLocations.set(runId, { ...run, directory: path.join(target, 'runs', runId) })
    }
    return { thread: threadFile.thread, manifest: threadFile.manifest, deletedAt, purgeAfter }
  }

  async listTrash(sessionId: string): Promise<TrashEntry[]> {
    const root = path.join(this.sessionsRoot, safeId(sessionId, 'sessionId'), 'trash')
    const entries: TrashEntry[] = []
    for (const threadId of await listDirectories(root)) {
      const directory = path.join(root, threadId)
      const threadFile = await this.readThreadFile(directory)
      const tombstone = await readRawJson(path.join(directory, 'tombstone.json'))
      entries.push({
        thread: threadFile.thread,
        manifest: threadFile.manifest,
        deletedAt: stringField(tombstone?.deletedAt) ?? threadFile.thread.updatedAt,
        purgeAfter: stringField(tombstone?.purgeAfter) ?? threadFile.thread.updatedAt,
      })
    }
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
  }

  async getTrashedThread(threadId: string): Promise<ThreadFile> {
    const location = this.requireThreadLocation(threadId)
    if (!location.trashed) throw new Error(`线程 '${threadId}' 不在回收站`)
    return this.readThreadFile(location.directory)
  }

  async restoreThread(threadId: string): Promise<ThreadFile> {
    const location = this.requireThreadLocation(threadId)
    if (!location.trashed) throw new Error(`线程 '${threadId}' 不在回收站`)
    const target = this.threadDirectory(location.sessionId, threadId)
    await mkdir(path.dirname(target), { recursive: true })
    await rm(path.join(location.directory, 'tombstone.json'), { force: true })
    await rename(location.directory, target)
    this.threadLocations.set(threadId, { ...location, directory: target, trashed: false })
    for (const [runId, run] of this.runLocations) {
      if (run.threadId === threadId) this.runLocations.set(runId, { ...run, directory: path.join(target, 'runs', runId) })
    }
    return this.readThreadFile(target)
  }

  async purgeThread(threadId: string): Promise<void> {
    const location = this.requireThreadLocation(threadId)
    if (!location.trashed) throw new Error('只能物理清理回收站中的线程')
    await rm(location.directory, { recursive: true, force: true })
    this.threadLocations.delete(threadId)
    for (const [runId, run] of this.runLocations) {
      if (run.threadId === threadId) this.runLocations.delete(runId)
    }
  }

  async purgeExpiredTrash(now = new Date()): Promise<string[]> {
    const purged: string[] = []
    for (const [threadId, location] of [...this.threadLocations]) {
      if (!location.trashed) continue
      const tombstone = await readRawJson(path.join(location.directory, 'tombstone.json'))
      const purgeAfter = stringField(tombstone?.purgeAfter)
      if (!purgeAfter || new Date(purgeAfter) > now) continue
      await this.purgeThread(threadId)
      purged.push(threadId)
    }
    return purged
  }

  // 会话、artifact 和上传 metadata 共同声明对象存活；回收站内对象在保留期结束前同样受保护。
  async garbageCollectObjects(): Promise<{ removed: number; retained: number }> {
    const referenced = new Set<string>()
    const runtimeRoot = path.dirname(this.root)
    const files = [
      ...await listFilesRecursively(this.sessionsRoot),
      ...await listFilesRecursively(path.join(runtimeRoot, 'uploads')),
    ]
    for (const filePath of files) {
      if (path.basename(filePath) === 'attachments.jsonl') {
        const latest = new Map<string, AttachmentRecord>()
        for (const line of (await readFile(filePath, 'utf8')).split('\n')) {
          if (!line.trim()) continue
          try {
            const value = JSON.parse(line) as AttachmentRecord
            if (value.attachmentId) latest.set(value.attachmentId, value)
          } catch { /* 损坏由 thread 读取路径负责隔离，GC 只跳过不可确认记录。 */ }
        }
        for (const record of latest.values()) {
          if (record.action === 'attached' && record.contentRef?.hash) referenced.add(record.contentRef.hash)
        }
        continue
      }
      if (!/\.(?:json|jsonl)$/u.test(filePath)) continue
      const content = await readFile(filePath, 'utf8')
      for (const match of content.matchAll(/(?:"hash"\s*:\s*"|objects\/sha256\/[a-f0-9]{2}\/)([a-f0-9]{64})/giu)) {
        referenced.add(match[1].toLowerCase())
      }
    }

    let removed = 0
    let retained = 0
    for (const prefix of await listDirectories(this.objectsRoot)) {
      const prefixRoot = path.join(this.objectsRoot, prefix)
      for (const objectName of await listFileNames(prefixRoot)) {
        if (referenced.has(objectName.toLowerCase())) retained += 1
        else {
          await rm(path.join(prefixRoot, objectName), { force: true })
          removed += 1
        }
      }
    }
    return { removed, retained }
  }

  async putObject(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relativePath = path.posix.join('objects', 'sha256', hash.slice(0, 2), hash)
    const target = path.join(this.objectsRoot, hash.slice(0, 2), hash)
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await writeFile(target, bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return { algorithm: 'sha256', hash, mediaType, sizeBytes: bytes.byteLength, relativePath }
  }

  async readObject(reference: ContentRef): Promise<Uint8Array> {
    if (reference.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/u.test(reference.hash)) {
      throw new Error('contentRef 哈希格式无效')
    }
    const target = path.join(this.objectsRoot, reference.hash.slice(0, 2), reference.hash)
    const bytes = await readFile(target)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== reference.hash) throw new Error(`contentRef 校验失败：${reference.hash}`)
    return bytes
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writeQueues.values()])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, `conversation store flush 失败：${failures.length} 个写入队列未完成`)
    }
  }

  private async ensureStoreManifest(): Promise<void> {
    const manifestPath = path.join(this.root, 'store.json')
    const current = await readRawJson(manifestPath)
    if (current && current.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new Error(`不支持的 conversation store 版本：${String(current.schemaVersion)}`)
    }
    if (!current) {
      await atomicWriteJson(manifestPath, {
        schemaVersion: STORE_SCHEMA_VERSION,
        kind: 'geoforge-file-conversation-store',
        createdAt: nowUtc(),
      })
    }
  }

  private async loadThreadDirectory(sessionId: string, threadId: string, trashed: boolean): Promise<(ThreadFile & { directory: string }) | null> {
    const safeThreadId = safeId(threadId, 'threadId')
    const directory = path.join(this.sessionsRoot, sessionId, trashed ? 'trash' : 'threads', safeThreadId)
    await this.recoverThreadJournals(directory)
    const loaded = await this.readThreadFileOrNull(directory)
    if (!loaded) return null
    this.threadLocations.set(safeThreadId, { sessionId, directory, trashed })
    return { ...loaded, directory }
  }

  private async loadRuns(sessionId: string, threadId: string, threadDirectory: string): Promise<AnalysisRun[]> {
    const runs: AnalysisRun[] = []
    const runsRoot = path.join(threadDirectory, 'runs')
    for (const runId of await listDirectories(runsRoot)) {
      const directory = path.join(runsRoot, safeId(runId, 'runId'))
      const checkpoint = await readJson(path.join(directory, 'run.json'), runCheckpointSchema)
      if (!checkpoint) continue
      if (checkpoint.run.status === 'running' || checkpoint.run.status === 'queued') {
        checkpoint.run.status = 'interrupted'
        checkpoint.run.updatedAt = nowUtc()
        checkpoint.run.state.runLifecycle = {
          status: 'interrupted',
          reason: 'server_restart',
          updatedAt: checkpoint.run.updatedAt,
        }
        checkpoint.recoveryStatus = 'interrupted'
        checkpoint.lastPersistedAt = checkpoint.run.updatedAt
        await atomicWriteJson(path.join(directory, 'run.json'), checkpoint)
      }
      this.runLocations.set(runId, { sessionId, threadId, directory })
      runs.push(checkpoint.run)
    }
    return runs
  }

  private enqueueAppend(filePath: string, record: unknown): Promise<void> {
    const previous = this.writeQueues.get(filePath)?.catch(error => {
      console.error(`[conversation-store] previous append failed for ${filePath}:`, error instanceof Error ? error.message : String(error))
    }) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await appendJsonLineDurable(filePath, record)
    })
    this.writeQueues.set(filePath, next)
    const tracked = next.catch(error => {
      console.error(`[conversation-store] append failed for ${filePath}:`, error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => {
      if (this.writeQueues.get(filePath) === next) this.writeQueues.delete(filePath)
    })
    return tracked
  }

  private async enqueueAppendAndWait(filePath: string, record: unknown): Promise<void> {
    await this.enqueueAppend(filePath, record)
  }

  private async readJsonLines<T>(
    filePath: string,
    threadId: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n')
    const records: T[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        records.push(schema.parse(JSON.parse(line)))
      } catch (error) {
        const isFinalPartialLine = index === lines.length - 1 && !text.endsWith('\n')
        if (isFinalPartialLine) break
        await recordJsonLineCorruption(filePath, threadId, index + 1, error)
      }
    }
    return records
  }

  private async quarantineThread(threadId: string, reason: string): Promise<void> {
    const location = this.requireThreadLocation(threadId)
    const current = await this.readThreadFile(location.directory)
    current.manifest.quarantined = true
    current.manifest.quarantineReason = reason
    current.manifest.updatedAt = nowUtc()
    await atomicWriteJson(path.join(location.directory, 'thread.json'), current)
  }

  private async readThreadFile(directory: string): Promise<ThreadFile> {
    const loaded = await this.readThreadFileOrNull(directory)
    if (!loaded) throw new Error(`thread manifest 不存在：${directory}`)
    return loaded
  }

  private async readThreadFileOrNull(directory: string): Promise<ThreadFile | null> {
    const raw = await readRawJson(path.join(directory, 'thread.json'))
    if (!raw || !isRecord(raw.thread) || !isRecord(raw.manifest)) return null
    return {
      thread: raw.thread as AgentThreadRecord,
      manifest: threadManifestSchema.parse(raw.manifest),
    }
  }

  private requireThreadLocation(threadId: string): ThreadLocation {
    const safeThreadId = safeId(threadId, 'threadId')
    const location = this.threadLocations.get(safeThreadId)
    if (!location) throw new Error(`线程 '${safeThreadId}' 不存在`)
    return location
  }

  private requireRunLocation(runId: string): RunLocation {
    const safeRunId = safeId(runId, 'runId')
    const location = this.runLocations.get(safeRunId)
    if (!location) throw new Error(`运行 '${safeRunId}' 不存在`)
    return location
  }

  private threadDirectory(sessionId: string, threadId: string): string {
    return path.join(this.sessionsRoot, safeId(sessionId, 'sessionId'), 'threads', safeId(threadId, 'threadId'))
  }

  private async withThreadLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      this.requireThreadLocation(threadId)
      return work()
    })
    this.threadQueues.set(threadId, next)
    try {
      return await next
    } finally {
      if (this.threadQueues.get(threadId) === next) this.threadQueues.delete(threadId)
    }
  }

  private async copyOptionalFile(source: string, target: string): Promise<void> {
    try {
      const content = await readFile(source)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
