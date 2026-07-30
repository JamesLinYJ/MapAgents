// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内存会话持久化测试替身
//
//   文件:       inMemoryConversationPersistence.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  compactionRecordSchema,
  conversationItemSchema,
  runCheckpointSchema,
  runEventSchema,
  runSteeringRecordSchema,
  threadManifestSchema,
  toolValueRefSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type AnalysisRun,
  type CompactionRecord,
  type ConversationItem,
  type RunEvent,
  type RunCheckpoint,
  type RunSteeringRecord,
  type SessionRecord,
  type ThreadManifest,
  type ThreadMemoryDocument,
  type ToolValueRef,
  type TranscriptEntry,
} from '../src/schemas/types.js'
import type {
  AppendConversationEntryInput,
  ConversationPersistence,
  ConversationSnapshot,
  DeletedThreadRecord,
  EnqueueRunInput,
  RunLifecycleResult,
  ThreadLifecycleResult,
  ThreadHistoryPage,
  ThreadMemoryVersionReference,
  TrashThreadLifecycleResult,
} from '../src/store/postgres/conversationPersistencePorts.js'
import { decodeHistoryCursor, encodeHistoryCursor, estimateTokens } from '../src/store/conversationEncoding.js'
import { makeId, nowUtc } from '../src/utils/ids.js'
import { summarizeAssistantText } from '../src/conversation/items.js'
import { MemoryVersionConflictError } from '../src/store/storeErrors.js'

interface ThreadState {
  record: AgentThreadRecord
  activeLeafEntryId: string | null
  nextEntrySequence: number
  transcriptEntryCount: number
  estimatedContextTokens: number
  latestCompactionId: string | null
  memoryVersion: number
  memoryBasedOnTokens: number
  forkedFromThreadId: string | null
  forkedFromEntryId: string | null
  quarantined: boolean
  quarantineReason: string | null
  deletedAt: string | null
  purgeAfter: string | null
}

type CheckpointMetadata = Omit<RunCheckpoint, 'run'>

// 仅用于单元测试的明确端口替身。它模拟 PostgreSQL Repository 的领域语义，
// 不进入生产 container，也不让生产代码识别残缺的假 Database。
export class InMemoryConversationPersistence implements ConversationPersistence {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly threads = new Map<string, ThreadState>()
  private readonly runs = new Map<string, AnalysisRun>()
  private readonly checkpoints = new Map<string, CheckpointMetadata>()
  private readonly entries = new Map<string, TranscriptEntry[]>()
  private readonly items = new Map<string, ConversationItem[]>()
  private readonly events = new Map<string, RunEvent[]>()
  private readonly values = new Map<string, ToolValueRef[]>()
  private readonly inputs = new Map<string, RunSteeringRecord[]>()
  private readonly memoryVersions = new Map<string, ThreadMemoryVersionReference[]>()
  private readonly compactions = new Map<string, CompactionRecord[]>()

  async loadSnapshot(): Promise<ConversationSnapshot> {
    const activeThreadIds = new Set(
      [...this.threads.values()].filter(state => state.record.status !== 'deleted').map(state => state.record.id),
    )
    return clone({
      sessions: [...this.sessions.values()],
      threads: [...this.threads.values()].map(state => state.record).filter(thread => thread.status !== 'deleted'),
      deletedThreads: [...this.threads.values()]
        .filter(state => state.record.status === 'deleted')
        .map(state => this.deletedThreadRecord(state)),
      runs: [...this.runs.values()].filter(run => run.threadId === null || activeThreadIds.has(run.threadId)),
    })
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, clone(session))
  }

  async createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    const session = this.sessions.get(thread.sessionId)
    if (!session || session.status !== 'active') throw new Error(`会话 '${thread.sessionId}' 不存在或不可用`)
    if (this.threads.has(thread.id)) throw new Error(`线程 '${thread.id}' 已存在`)
    assertThreadOwnerMatchesSession(thread, session)
    const state = createThreadState(thread)
    this.threads.set(thread.id, state)
    const updatedSession = { ...session, latestThreadId: thread.id }
    this.sessions.set(session.id, updatedSession)
    return clone({
      session: updatedSession,
      thread,
      manifest: this.threadManifest(state),
    })
  }

  async saveThread(thread: AgentThreadRecord): Promise<void> {
    if (thread.status === 'deleted') {
      throw new Error('删除线程必须使用 trashThread，以保证回收站时间元数据完整')
    }
    const current = this.threads.get(thread.id)
    if (!current || current.record.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)
    this.threads.set(thread.id, {
      record: clone(thread),
      activeLeafEntryId: current.activeLeafEntryId,
      nextEntrySequence: current.nextEntrySequence,
      transcriptEntryCount: current.transcriptEntryCount,
      estimatedContextTokens: current.estimatedContextTokens,
      latestCompactionId: current.latestCompactionId,
      memoryVersion: current.memoryVersion,
      memoryBasedOnTokens: current.memoryBasedOnTokens,
      forkedFromThreadId: current.forkedFromThreadId,
      forkedFromEntryId: current.forkedFromEntryId,
      quarantined: current.quarantined,
      quarantineReason: current.quarantineReason,
      deletedAt: null,
      purgeAfter: null,
    })
  }

  async trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    const state = this.requireThread(thread.id)
    if (state.record.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)
    const session = this.sessions.get(thread.sessionId)
    if (!session) throw new Error(`会话 '${thread.sessionId}' 不存在`)
    const replacement = replacementThreadId ? this.requireThread(replacementThreadId) : null
    if (replacement && (replacement.record.sessionId !== thread.sessionId || replacement.record.status === 'deleted')) {
      throw new Error(`替代线程 '${replacementThreadId}' 不存在或不属于当前会话`)
    }
    state.record = clone(thread)
    state.deletedAt = thread.updatedAt
    state.purgeAfter = purgeAfter
    const latestRun = session.latestRunId ? this.runs.get(session.latestRunId) ?? null : null
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId === thread.id
        ? replacement?.record.id ?? null
        : session.latestThreadId,
      latestRunId: latestRun?.threadId === thread.id
        ? replacement?.record.latestRunId ?? null
        : session.latestRunId,
    }
    this.sessions.set(session.id, updatedSession)
    return clone({ session: updatedSession, deleted: this.deletedThreadRecord(state) })
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    return clone([...this.threads.values()]
      .filter(state => state.record.sessionId === sessionId && state.record.status === 'deleted')
      .sort((left, right) => (right.deletedAt ?? '').localeCompare(left.deletedAt ?? ''))
      .map(state => this.deletedThreadRecord(state)))
  }

  async getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted') throw new Error(`回收站线程 '${threadId}' 不存在`)
    return clone(this.deletedThreadRecord(state))
  }

  async restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted' || state.record.sessionId !== sessionId) {
      throw new Error(`回收站线程 '${threadId}' 不存在`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
    state.record = { ...state.record, status: 'active', updatedAt: nowUtc() }
    state.deletedAt = null
    state.purgeAfter = null
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId ?? threadId,
      latestRunId: session.latestRunId ?? state.record.latestRunId,
    }
    this.sessions.set(sessionId, updatedSession)
    return clone({ session: updatedSession, thread: state.record, manifest: this.threadManifest(state) })
  }

  async purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    const state = this.requireThread(threadId)
    if (state.record.status !== 'deleted' || state.record.sessionId !== sessionId) {
      throw new Error(`回收站线程 '${threadId}' 不存在`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
    const latestRunBelongsToThread = session.latestRunId
      ? this.runs.get(session.latestRunId)?.threadId === threadId
      : false
    this.threads.delete(threadId)
    this.entries.delete(threadId)
    this.memoryVersions.delete(threadId)
    this.compactions.delete(threadId)
    for (const [runId, run] of this.runs) {
      if (run.threadId !== threadId) continue
      this.runs.delete(runId)
      this.checkpoints.delete(runId)
      this.items.delete(runId)
      this.events.delete(runId)
      this.values.delete(runId)
      this.inputs.delete(runId)
    }
    const updatedSession: SessionRecord = {
      ...session,
      latestThreadId: session.latestThreadId === threadId ? null : session.latestThreadId,
      latestRunId: latestRunBelongsToThread ? null : session.latestRunId,
    }
    this.sessions.set(sessionId, updatedSession)
    return clone(updatedSession)
  }

  async createRunLifecycle(run: AnalysisRun): Promise<RunLifecycleResult> {
    const session = this.sessions.get(run.sessionId)
    if (!session || session.status !== 'active') throw new Error(`会话 '${run.sessionId}' 不存在或不可用`)
    if (this.runs.has(run.id)) throw new Error(`运行 '${run.id}' 已存在`)
    const thread = run.threadId ? this.requireThread(run.threadId) : null
    if (thread) {
      if (thread.record.sessionId !== run.sessionId || thread.record.status === 'deleted') {
        throw new Error(`线程 '${run.threadId}' 不存在或不属于当前会话`)
      }
      assertRunOwnerMatchesThread(run, thread.record)
    } else {
      assertRunOwnerMatchesSession(run, session)
    }
    this.runs.set(run.id, clone(run))
    this.checkpoints.set(run.id, initialCheckpoint(run.updatedAt))
    let updatedThread: AgentThreadRecord | null = null
    if (thread) {
      updatedThread = {
        ...thread.record,
        latestRunId: run.id,
        latestUserQuery: run.userQuery,
        latestRunStatus: run.status,
        runCount: thread.record.runCount + 1,
        updatedAt: run.updatedAt,
      }
      thread.record = updatedThread
    }
    const updatedSession: SessionRecord = {
      ...session,
      latestRunId: run.id,
      latestThreadId: updatedThread?.id ?? session.latestThreadId,
    }
    this.sessions.set(session.id, updatedSession)
    return clone({ session: updatedSession, thread: updatedThread, run })
  }

  async saveRun(run: AnalysisRun): Promise<void> {
    this.requireRun(run.id)
    this.runs.set(run.id, clone(run))
  }

  async saveRunWithCheckpoint(
    run: AnalysisRun,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    this.requireRun(run.id)
    const current = this.requireCheckpoint(run.id)
    this.runs.set(run.id, clone(run))
    this.checkpoints.set(run.id, {
      ...current,
      ...clone(fields),
      lastPersistedAt: run.updatedAt,
    })
  }

  async listRunsForThread(threadId: string): Promise<AnalysisRun[]> {
    return clone([...this.runs.values()]
      .filter(run => run.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
  }

  async saveRunCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>>,
  ): Promise<void> {
    const run = this.requireRun(runId)
    const current = this.requireCheckpoint(runId)
    this.checkpoints.set(runId, {
      ...current,
      ...clone(fields),
      lastPersistedAt: run.updatedAt,
    })
  }

  async getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
    return runCheckpointSchema.parse({
      ...clone(this.requireCheckpoint(runId)),
      run: clone(this.requireRun(runId)),
    })
  }

  async saveAgentsSdkCheckpoint(runId: string, input: {
    contentHash: string
    agentsSdkVersion: string
    runtimeConfigDigest: string
    sdkStateSchemaVersion: RunCheckpoint['sdkStateSchemaVersion']
  }): Promise<void> {
    const current = this.requireCheckpoint(runId)
    const updatedAt = nowUtc()
    this.checkpoints.set(runId, {
      ...current,
      lastPersistedAt: updatedAt,
      orchestrationEngine: 'openai_agents',
      sdkStateContentHash: input.contentHash,
      agentsSdkVersion: input.agentsSdkVersion,
      runtimeConfigDigest: input.runtimeConfigDigest,
      sdkStateSchemaVersion: input.sdkStateSchemaVersion,
      sdkStateUpdatedAt: updatedAt,
    })
  }

  async appendConversationItem(item: ConversationItem): Promise<void> {
    const run = this.requireRun(item.runId)
    const parsed = conversationItemSchema.parse(item)
    this.items.set(item.runId, [...(this.items.get(item.runId) ?? []), clone(parsed)])
    if (!run.threadId) return
    const thread = this.requireThread(run.threadId)
    if (parsed.itemType === 'message' && parsed.role === 'assistant') {
      const summary = summarizeAssistantText(parsed.body ?? '')
      if (summary) thread.record = { ...thread.record, latestAssistantSummary: summary, updatedAt: nowUtc() }
    } else if (parsed.itemType === 'result') {
      thread.record = { ...thread.record, latestRunStatus: run.status, updatedAt: nowUtc() }
    }
  }

  async listConversationItems(runId: string): Promise<ConversationItem[]> {
    this.requireRun(runId)
    const latest = new Map<string, ConversationItem>()
    for (const item of this.items.get(runId) ?? []) latest.set(item.itemId, item)
    return clone([...latest.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)))
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.requireRun(event.runId)
    const parsed = runEventSchema.parse(event)
    this.events.set(event.runId, [...(this.events.get(event.runId) ?? []), clone(parsed)])
  }

  async listRunEvents(runId: string): Promise<RunEvent[]> {
    this.requireRun(runId)
    return clone(this.events.get(runId) ?? [])
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    this.requireRun(runId)
    const parsed = toolValueRefSchema.parse(value)
    this.values.set(runId, [...(this.values.get(runId) ?? []), clone(parsed)])
  }

  async listToolValues(runId: string): Promise<ToolValueRef[]> {
    this.requireRun(runId)
    return clone(this.values.get(runId) ?? [])
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    return clone(this.threadManifest(state))
  }

  private threadManifest(state: ThreadState): ThreadManifest {
    return threadManifestSchema.parse({
      schemaVersion: 2,
      threadId: state.record.id,
      sessionId: state.record.sessionId,
      activeLeafEntryId: state.activeLeafEntryId,
      lastSequence: state.nextEntrySequence - 1,
      transcriptEntryCount: state.transcriptEntryCount,
      estimatedContextTokens: state.estimatedContextTokens,
      latestCompactionId: state.latestCompactionId,
      memoryVersion: state.memoryVersion,
      memoryBasedOnTokens: state.memoryBasedOnTokens,
      forkedFrom: state.forkedFromThreadId && state.forkedFromEntryId
        ? { threadId: state.forkedFromThreadId, entryId: state.forkedFromEntryId }
        : null,
      quarantined: state.quarantined,
      quarantineReason: state.quarantineReason,
      createdAt: state.record.createdAt,
      updatedAt: state.record.updatedAt,
    })
  }

  async saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference> {
    const state = this.requireThread(input.threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${input.threadId}' 不存在`)
    if (state.memoryVersion !== input.expectedVersion) {
      throw new MemoryVersionConflictError(input.expectedVersion, state.memoryVersion)
    }
    if (input.version !== state.memoryVersion + 1) {
      throw new Error(`线程记忆版本必须从 ${state.memoryVersion} 递增到 ${state.memoryVersion + 1}`)
    }
    const reference: ThreadMemoryVersionReference = clone(input)
    this.memoryVersions.set(input.threadId, [
      ...(this.memoryVersions.get(input.threadId) ?? []),
      reference,
    ])
    state.memoryVersion = input.version
    state.memoryBasedOnTokens = state.estimatedContextTokens
    state.record = { ...state.record, updatedAt: input.createdAt }
    return clone(reference)
  }

  async getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    const versions = this.memoryVersions.get(threadId) ?? []
    return versions.length ? clone(versions[versions.length - 1]!) : null
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    const parsed = compactionRecordSchema.parse(record)
    const state = this.requireThread(parsed.threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${parsed.threadId}' 不存在`)
    const current = this.compactions.get(parsed.threadId) ?? []
    const existing = current.find(item => item.compactionId === parsed.compactionId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
        throw new Error(`压缩记录 '${parsed.compactionId}' 与首次写入不一致`)
      }
      return
    }
    this.compactions.set(parsed.threadId, [...current, clone(parsed)])
    state.latestCompactionId = parsed.compactionId
    state.estimatedContextTokens = parsed.postTokens
    state.record = { ...state.record, updatedAt: parsed.createdAt }
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    const state = this.requireThread(threadId)
    if (state.record.status === 'deleted') throw new Error(`线程 '${threadId}' 不存在`)
    return clone(this.compactions.get(threadId) ?? [])
  }

  async listReferencedObjectHashes(): Promise<string[]> {
    const hashes = new Set<string>()
    for (const checkpoint of this.checkpoints.values()) collectSha256Strings(checkpoint, hashes)
    for (const versions of this.memoryVersions.values()) collectSha256Strings(versions, hashes)
    for (const entries of this.entries.values()) collectSha256Strings(entries, hashes)
    for (const items of this.items.values()) collectSha256Strings(items, hashes)
    for (const events of this.events.values()) collectSha256Strings(events, hashes)
    for (const values of this.values.values()) collectSha256Strings(values, hashes)
    return [...hashes]
  }

  async appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    const state = this.requireThread(input.threadId)
    const existing = input.entryId
      ? (this.entries.get(input.threadId) ?? []).find(entry => entry.entryId === input.entryId)
      : null
    if (existing) return clone(existing)
    const parentEntryId = input.parentEntryId === undefined ? state.activeLeafEntryId : input.parentEntryId
    this.assertEntry(input.threadId, parentEntryId ?? null)
    this.assertEntry(input.threadId, input.logicalParentEntryId ?? null)
    const entry = transcriptEntrySchema.parse({
      schemaVersion: 2,
      seq: state.nextEntrySequence,
      entryId: input.entryId ?? makeId('entry'),
      parentEntryId: parentEntryId ?? null,
      logicalParentEntryId: input.logicalParentEntryId ?? null,
      threadId: input.threadId,
      runId: input.runId ?? null,
      turnId: input.turnId ?? null,
      kind: input.kind,
      timestamp: nowUtc(),
      payload: input.payload ?? {},
    })
    this.entries.set(input.threadId, [...(this.entries.get(input.threadId) ?? []), entry])
    state.activeLeafEntryId = entry.entryId
    state.nextEntrySequence += 1
    state.transcriptEntryCount += 1
    state.estimatedContextTokens += estimateTokens(JSON.stringify(entry.payload))
    state.record = { ...state.record, updatedAt: entry.timestamp }
    return clone(entry)
  }

  async readThreadHistory(threadId: string, cursor?: string | null, limit = 50): Promise<ThreadHistoryPage> {
    this.requireThread(threadId)
    const bounded = Math.min(200, Math.max(1, Math.trunc(limit)))
    const before = cursor ? decodeHistoryCursor(cursor) : Number.POSITIVE_INFINITY
    const eligible = (this.entries.get(threadId) ?? []).filter(entry => entry.seq < before)
    const selected = eligible.slice(Math.max(0, eligible.length - bounded))
    return {
      entries: clone(selected),
      nextCursor: selected.length && selected[0]!.seq > 1 ? encodeHistoryCursor(selected[0]!.seq) : null,
    }
  }

  async readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    const state = this.requireThread(threadId)
    const entries = this.entries.get(threadId) ?? []
    const byId = new Map(entries.map(entry => [entry.entryId, entry]))
    const chain: TranscriptEntry[] = []
    let cursor = leafEntryId ?? state.activeLeafEntryId
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) throw new Error(`线程 '${threadId}' 的父链存在循环`)
      visited.add(cursor)
      const entry = byId.get(cursor)
      if (!entry) throw new Error(`对话条目 '${cursor}' 不存在`)
      chain.push(entry)
      cursor = entry.parentEntryId
    }
    return clone(chain.reverse())
  }

  async forkConversation(sourceThreadId: string, targetThreadId: string, sourceEntryId: string): Promise<Map<string, string>> {
    const source = await this.readActiveConversation(sourceThreadId, sourceEntryId)
    const target = this.requireThread(targetThreadId)
    const mapping = new Map<string, string>()
    for (const entry of source) {
      const nextId = makeId('entry')
      const copied = await this.appendConversationEntry({
        threadId: targetThreadId,
        runId: null,
        turnId: entry.turnId,
        kind: entry.kind,
        payload: entry.payload,
        parentEntryId: entry.parentEntryId ? mapping.get(entry.parentEntryId) ?? null : null,
        logicalParentEntryId: entry.logicalParentEntryId ? mapping.get(entry.logicalParentEntryId) ?? null : null,
        entryId: nextId,
      })
      mapping.set(entry.entryId, copied.entryId)
    }
    target.forkedFromThreadId = sourceThreadId
    target.forkedFromEntryId = sourceEntryId
    return mapping
  }

  async enqueueRunInput(input: EnqueueRunInput): Promise<RunSteeringRecord> {
    const existing = (this.inputs.get(input.runId) ?? []).find(record => record.steeringId === input.inputId)
    if (existing) {
      if (existing.content !== input.content.trim()) throw new Error(`引导消息 '${input.inputId}' 的内容与首次提交不一致`)
      return clone(existing)
    }
    const run = this.requireRun(input.runId)
    if (!run.threadId) throw new Error(`运行 '${input.runId}' 缺少 threadId`)
    const content = input.content.trim()
    const entry = await this.appendConversationEntry({
      threadId: run.threadId,
      runId: run.id,
      kind: 'message',
      payload: { role: 'user', content, steeringId: input.inputId },
      entryId: input.entryId,
    })
    const record = runSteeringRecordSchema.parse({
      schemaVersion: 1,
      steeringId: input.inputId,
      entryId: entry.entryId,
      itemId: input.itemId,
      runId: run.id,
      threadId: run.threadId,
      content,
      status: 'queued',
      queuedAt: entry.timestamp,
      consumedAt: null,
    })
    this.inputs.set(run.id, [...(this.inputs.get(run.id) ?? []), record])
    return clone(record)
  }

  async consumeRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    this.requireRun(runId)
    const consumedAt = nowUtc()
    const consumed: RunSteeringRecord[] = []
    const next = (this.inputs.get(runId) ?? []).map(record => {
      if (record.status !== 'queued') return record
      const updated = runSteeringRecordSchema.parse({ ...record, status: 'consumed', consumedAt })
      consumed.push(updated)
      return updated
    })
    this.inputs.set(runId, next)
    return clone(consumed)
  }

  async listRunInputs(runId: string): Promise<RunSteeringRecord[]> {
    this.requireRun(runId)
    return clone(this.inputs.get(runId) ?? [])
  }

  private requireThread(threadId: string): ThreadState {
    const state = this.threads.get(threadId)
    if (!state) throw new Error(`线程 '${threadId}' 不存在`)
    return state
  }

  private requireRun(runId: string): AnalysisRun {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`运行 '${runId}' 不存在`)
    return run
  }

  private requireCheckpoint(runId: string): CheckpointMetadata {
    const checkpoint = this.checkpoints.get(runId)
    if (!checkpoint) throw new Error(`运行 '${runId}' 检查点不存在`)
    return checkpoint
  }

  private assertEntry(threadId: string, entryId: string | null): void {
    if (!entryId) return
    if (!(this.entries.get(threadId) ?? []).some(entry => entry.entryId === entryId)) {
      throw new Error(`父对话条目 '${entryId}' 不属于线程 '${threadId}'`)
    }
  }

  private deletedThreadRecord(state: ThreadState): DeletedThreadRecord {
    if (!state.deletedAt || !state.purgeAfter) {
      throw new Error(`已删除线程 '${state.record.id}' 缺少回收站时间信息`)
    }
    return {
      thread: clone(state.record),
      manifest: this.threadManifest(state),
      deletedAt: state.deletedAt,
      purgeAfter: state.purgeAfter,
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createThreadState(thread: AgentThreadRecord): ThreadState {
  return {
    record: clone(thread),
    activeLeafEntryId: null,
    nextEntrySequence: 1,
    transcriptEntryCount: 0,
    estimatedContextTokens: 0,
    latestCompactionId: null,
    memoryVersion: 0,
    memoryBasedOnTokens: 0,
    forkedFromThreadId: null,
    forkedFromEntryId: null,
    quarantined: false,
    quarantineReason: null,
    deletedAt: null,
    purgeAfter: null,
  }
}

function initialCheckpoint(updatedAt: string): CheckpointMetadata {
  return {
    schemaVersion: 2,
    activeEntryId: null,
    pendingToolCallIds: [],
    lastPersistedAt: updatedAt,
    recoveryStatus: 'clean',
    orchestrationEngine: null,
    sdkStateContentHash: null,
    agentsSdkVersion: null,
    runtimeConfigDigest: null,
    sdkStateSchemaVersion: null,
    sdkStateUpdatedAt: null,
  }
}

function assertThreadOwnerMatchesSession(thread: AgentThreadRecord, session: SessionRecord): void {
  if (
    thread.workspaceId !== session.workspaceId
    || thread.createdByUserId !== session.createdByUserId
    || thread.visibility !== session.visibility
  ) {
    throw new Error(`线程 '${thread.id}' 的资源归属与会话 '${session.id}' 不一致`)
  }
}

function assertRunOwnerMatchesThread(run: AnalysisRun, thread: AgentThreadRecord): void {
  if (
    run.workspaceId !== thread.workspaceId
    || run.createdByUserId !== thread.createdByUserId
    || run.visibility !== thread.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与线程 '${thread.id}' 不一致`)
  }
}

function assertRunOwnerMatchesSession(run: AnalysisRun, session: SessionRecord): void {
  if (
    run.workspaceId !== session.workspaceId
    || run.createdByUserId !== session.createdByUserId
    || run.visibility !== session.visibility
  ) {
    throw new Error(`运行 '${run.id}' 的资源归属与会话 '${session.id}' 不一致`)
  }
}

function collectSha256Strings(value: unknown, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/u.test(value)) hashes.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSha256Strings(item, hashes)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) collectSha256Strings(item, hashes)
}
