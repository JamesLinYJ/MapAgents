// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行资源存储
//
//   文件:       runStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type {
  AgentRuntimeConfig,
  AgentState,
  AnalysisRun,
  ArtifactRef,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  RunSummary,
  ToolValueRef,
} from '../schemas/types.js'
import { AGENTS_SDK_STATE_SCHEMA_VERSION } from '../schemas/types.js'
import { summarizeAssistantText } from '../conversation/items.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'
import {
  decodeRunCursor,
  compareRuns,
  encodeRunCursor,
  isRunAfterCursor,
  toRunSummary,
} from './runProjection.js'
import type { SessionStore } from './sessionStore.js'
import type { RunRepository, ThreadLifecycleRepository, ToolResultCommitter } from './postgres/conversationPersistencePorts.js'

export interface RunStoreEvents {
  runBus: InMemoryEventBus<AnalysisRun>
  eventBus: InMemoryEventBus<RunEvent>
  itemBus: InMemoryEventBus<ConversationItem>
}

// RunStore 拥有 run manifest、checkpoint、event 和 item 追加写入。
// session/thread 上的 latest* 字段是 run 的投影，由这里同步维护。
export class RunStore {
  private readonly durableRunningItems = new Map<string, Set<string>>()
  private readonly stateMutationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly payloadStore: ConversationPayloadStore,
    private readonly sessionStore: SessionStore,
    private readonly repository: RunRepository & ToolResultCommitter,
    private readonly threadWriter: Pick<ThreadLifecycleRepository, 'saveThread'>,
    private readonly events: RunStoreEvents,
  ) {}

  listForSession(sessionId: string): AnalysisRun[] {
    return this.index.listRunsForSession(sessionId)
  }

  listForThread(threadId: string): AnalysisRun[] {
    return this.index.listRunsForThread(threadId)
  }

  listForWorkspace(workspaceId: string): AnalysisRun[] {
    return [...this.index.runValues()]
      .filter(run => run.workspaceId === workspaceId)
      .sort(compareRuns)
  }

  listSummaries(options: {
    sessionId: string
    threadId?: string | null
    cursor?: string | null
    limit?: number
  }): { items: RunSummary[]; nextCursor: string | null } {
    this.sessionStore.get(options.sessionId)
    if (options.threadId) {
      const thread = this.index.getThread(options.threadId)
      if (thread.sessionId !== options.sessionId) throw new Error('threadId 不属于当前 session')
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
    const cursor = options.cursor ? decodeRunCursor(options.cursor) : null
    const source = options.threadId
      ? this.listForThread(options.threadId)
      : this.listForSession(options.sessionId)
    const eligible = cursor
      ? source.filter(run => isRunAfterCursor(run, cursor))
      : source
    const page = eligible.slice(0, limit + 1)
    const hasMore = page.length > limit
    const selected = hasMore ? page.slice(0, limit) : page
    const lastSelected = selected.at(-1)

    return {
      items: selected.map(toRunSummary),
      nextCursor: hasMore && lastSelected ? encodeRunCursor(lastSelected) : null,
    }
  }

  get(runId: string): AnalysisRun {
    return this.index.getRun(runId)
  }

  // 单写实例启动后，内存中不存在上一进程的执行器。遗留的 queued/running
  // Run 必须原子转为可恢复终态，不能继续向 UI 投影成“正在执行”。
  async recoverOrphanedRuns(): Promise<AnalysisRun[]> {
    const recovered: AnalysisRun[] = []
    const candidates = [...this.index.runValues()]
      .filter(run => run.status === 'queued' || run.status === 'running')
      .sort(compareRuns)
    for (const run of candidates) {
      const checkpoint = await this.repository.getRunCheckpoint(run.id)
      const requiresAction = checkpoint.recoveryStatus === 'requires_action'
        || checkpoint.pendingToolCallIds.length > 0
      const status: AnalysisRun['status'] = requiresAction ? 'requires_action' : 'interrupted'
      const reason = requiresAction
        ? `服务进程重启时发现状态未知的工具调用：${checkpoint.pendingToolCallIds.join('、') || 'checkpoint 标记需要操作'}。系统未自动重放。`
        : '服务进程重启时该运行仍处于活动状态，已标记为中断；如需继续，必须由用户显式恢复。'
      const updatedAt = nowUtc()
      const next: AnalysisRun = {
        ...run,
        status,
        updatedAt,
        state: {
          ...run.state,
          warnings: run.state.warnings.includes(reason)
            ? run.state.warnings
            : [...run.state.warnings, reason],
          runLifecycle: { status, reason, updatedAt },
        },
      }
      await this.repository.saveRunWithCheckpoint(next, {
        pendingToolCallIds: checkpoint.pendingToolCallIds,
        recoveryStatus: requiresAction ? 'requires_action' : 'interrupted',
      })
      this.index.setRun(next)
      this.events.runBus.publish(next.id, structuredClone(next))
      await this.persistDerivedThreadRunStatusProjection(run, status, updatedAt)
      recovered.push(next)
    }
    return recovered
  }

  async create(sessionId: string, query: string, opts?: {
    threadId?: string | null
    modelProvider?: string | null
    modelName?: string | null
    runtimeConfigSnapshot?: AgentRuntimeConfig | null
  }): Promise<AnalysisRun> {
    const session = this.sessionStore.get(sessionId)
    const thread = opts?.threadId ? this.index.getThread(opts.threadId) : null
    if (thread && thread.sessionId !== sessionId) throw new Error('run 的 thread 不属于当前 session')
    const now = nowUtc()
    const run: AnalysisRun = {
      id: makeId('run'),
      threadId: opts?.threadId ?? null,
      sessionId,
      workspaceId: thread?.workspaceId ?? session.workspaceId,
      createdByUserId: thread?.createdByUserId ?? session.createdByUserId,
      visibility: thread?.visibility ?? session.visibility,
      userQuery: query,
      modelProvider: opts?.modelProvider ?? null,
      modelName: opts?.modelName ?? null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      conversationPath: opts?.threadId ? `conversations/sessions/${sessionId}/threads/${opts.threadId}/runs` : null,
      runtimeConfigSnapshot: opts?.runtimeConfigSnapshot ?? null,
      state: {
        sessionId,
        threadId: opts?.threadId ?? null,
        userQuery: query,
        modelProvider: opts?.modelProvider ?? null,
        modelName: opts?.modelName ?? null,
        loopTrace: [],
        todos: [],
        tasks: [],
        subAgents: [],
        activeSkills: [],
        activeMcpServers: [],
        approvals: [],
        decisions: [],
        toolResults: [],
        toolValueRefs: [],
        artifacts: [],
        selectedDataSources: [],
        warnings: [],
        errors: [],
        failure: null,
        denialCounts: {},
        runtimeStats: {},
        currentStep: 0,
        loopIteration: 0,
        loopPhase: 'idle',
        planRepairAttempts: 0,
        planMode: false,
        contextReferences: [],
        contextResolution: null,
        parsedIntent: null,
        clarification: null,
        placeResolution: null,
        agentWorkflow: null,
        runLifecycle: { status: 'created', reason: null, updatedAt: null },
        failedStepId: null,
        failedTool: null,
      },
    }
    const persisted = await this.repository.createRunLifecycle(run)
    this.payloadStore.registerRun(persisted.run)
    this.sessionStore.acceptPersisted(persisted.session)
    if (persisted.thread) this.index.setThread(persisted.thread)
    this.index.setRun(persisted.run)
    this.events.runBus.publish(run.id, structuredClone(persisted.run))
    return persisted.run
  }

  async updateState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun> {
    return this.mutateState(runId, () => updates)
  }

  async commitToolResult(
    runId: string,
    resultId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
    values: readonly ToolValueRef[],
    artifacts: readonly ArtifactRef[],
  ): Promise<boolean> {
    let committed = false
    await this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const updates = mutation(run.state)
      const next = { ...run, state: { ...run.state, ...updates }, updatedAt: nowUtc() }
      committed = await this.repository.commitToolResult(next, resultId, values, artifacts)
      if (!committed) return
      this.index.setRun(next)
      this.updateThreadProjectionFromArtifacts(next, artifacts)
      this.events.runBus.publish(runId, structuredClone(next))
    })
    return committed
  }

  // Run 状态的读-改-写必须在同一串行边界内完成。仅序列化数据库 save
  // 不足以保护内存投影：并行调用可能先读到同一旧快照，再依次覆盖新状态。
  async mutateState(
    runId: string,
    mutation: (state: AgentState) => Partial<AgentState>,
  ): Promise<AnalysisRun> {
    return this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const updates = mutation(run.state)
      const next = { ...run, state: { ...run.state, ...updates }, updatedAt: nowUtc() }
      await this.repository.saveRun(next)
      this.index.setRun(next)
      this.events.runBus.publish(runId, structuredClone(next))
      return next
    })
  }

  async updateStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun> {
    return this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const next = { ...run, status, updatedAt: nowUtc() }
      await this.repository.saveRunWithCheckpoint(next, {
        recoveryStatus: status === 'interrupted' ? 'interrupted' : status === 'requires_action' ? 'requires_action' : 'clean',
      })
      this.index.setRun(next)
      this.events.runBus.publish(runId, structuredClone(next))
      await this.persistDerivedThreadRunStatusProjection(run, status, next.updatedAt)
      return next
    })
  }

  async complete(runId: string, status: string): Promise<AnalysisRun> {
    return this.serializeStateMutation(runId, async () => {
      const run = this.get(runId)
      const next = { ...run, status: status as AnalysisRun['status'], updatedAt: nowUtc() }
      await this.repository.saveRunWithCheckpoint(next, {
        recoveryStatus: next.status === 'waiting_approval' || next.status === 'requires_action'
          ? 'requires_action'
          : 'clean',
      })
      await this.payloadStore.flush()
      this.index.setRun(next)
      this.events.runBus.publish(runId, structuredClone(next))
      await this.persistDerivedThreadRunStatusProjection(run, next.status, next.updatedAt)
      this.durableRunningItems.delete(runId)
      return next
    })
  }

  async saveCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    this.get(runId)
    await this.repository.saveRunCheckpoint(runId, fields)
  }

  async getCheckpoint(runId: string): Promise<RunCheckpoint> {
    this.get(runId)
    return this.repository.getRunCheckpoint(runId)
  }

  async appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void> {
    this.get(runId)
    await this.payloadStore.appendAgentTranscript(runId, agentId, record)
  }

  async saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: { agentsSdkVersion: string; runtimeConfigDigest: string },
  ): Promise<void> {
    this.get(runId)
    const reference = await this.payloadStore.putObject(
      serializedState,
      'application/vnd.geo-agent-platform.agents-state+json',
    )
    await this.repository.saveAgentsSdkCheckpoint(runId, {
      contentHash: reference.hash,
      agentsSdkVersion: metadata.agentsSdkVersion,
      runtimeConfigDigest: metadata.runtimeConfigDigest,
      sdkStateSchemaVersion: AGENTS_SDK_STATE_SCHEMA_VERSION,
    })
  }

  async readAgentsSdkState(runId: string): Promise<string> {
    this.get(runId)
    const checkpoint = await this.repository.getRunCheckpoint(runId)
    const hash = checkpoint.sdkStateContentHash
    if (!hash) throw new Error(`run '${runId}' 缺少 Agents SDK 状态，不能恢复`)
    const bytes = await this.payloadStore.readObjectByHash(hash)
    return Buffer.from(bytes).toString('utf8')
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    this.get(runId)
    await this.repository.appendToolValue(runId, value)
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    this.get(runId)
    await this.repository.appendRunEvent(event)
    this.events.eventBus.publish(runId, event)
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    this.get(runId)
    return this.repository.listRunEvents(runId)
  }

  async appendItem(item: ConversationItem): Promise<void> {
    this.get(item.runId)
    if (this.shouldPersistItem(item)) {
      await this.repository.appendConversationItem(item)
    }
    this.events.itemBus.publish(item.runId, item)
    if (item.status !== 'running') this.updateThreadProjectionFromItem(item)
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    this.get(runId)
    const persisted = await this.repository.listConversationItems(runId)
    const byItemId = new Map<string, ConversationItem>()
    for (const item of persisted) {
      byItemId.set(item.itemId, item)
    }
    return orderConversationItems([...byItemId.values()])
  }

  private async persistThreadRunStatus(run: AnalysisRun, status: AnalysisRun['status'], updatedAt: string): Promise<void> {
    if (!run.threadId) return
    const thread = this.index.getThreadOrNull(run.threadId)
    if (!thread) return
    const nextThread = { ...thread, latestRunStatus: status, updatedAt }
    await this.threadWriter.saveThread(nextThread)
    this.index.setThread(nextThread)
  }

  // PostgreSQL run records are the durable fact source. Thread latest status is
  // a derived navigation projection and must never replace the run fact.
  private async persistDerivedThreadRunStatusProjection(run: AnalysisRun, status: AnalysisRun['status'], updatedAt: string): Promise<void> {
    try {
      await this.persistThreadRunStatus(run, status, updatedAt)
    } catch (error) {
      logger.warn({
        error: errorLogPayload(error),
        runId: run.id,
        threadId: run.threadId,
        status,
      }, 'thread run-status projection failed')
    }
  }

  private updateThreadProjectionFromItem(item: ConversationItem): void {
    if (!item.threadId) return
    const thread = this.index.getThreadOrNull(item.threadId)
    if (!thread) return

    let next = thread
    if (item.itemType === 'message' && item.role === 'assistant') {
      const summary = summarizeAssistantText(item.body ?? '')
      if (summary && thread.latestAssistantSummary !== summary) {
        next = { ...next, latestAssistantSummary: summary }
      }
    }
    if (item.itemType === 'result') {
      const run = this.index.getRunOrNull(item.runId)
      if (run && thread.latestRunStatus !== run.status) {
        next = { ...next, latestRunStatus: run.status }
      }
    }

    if (next === thread) return
    next = { ...next, updatedAt: nowUtc() }
    this.index.setThread(next)
  }

  private updateThreadProjectionFromArtifacts(
    run: AnalysisRun,
    artifacts: readonly ArtifactRef[],
  ): void {
    const latest = [...artifacts].reverse().find(artifact => !artifact.isIntermediate)
    if (!latest || !run.threadId) return
    const thread = this.index.getThreadOrNull(run.threadId)
    if (!thread) return
    this.index.setThread({
      ...thread,
      latestArtifactId: latest.artifactId,
      latestArtifactName: latest.name,
      updatedAt: nowUtc(),
    })
  }

  private shouldPersistItem(item: ConversationItem): boolean {
    if (item.status !== 'running') {
      this.durableRunningItems.get(item.runId)?.delete(item.itemId)
      return true
    }

    let itemIds = this.durableRunningItems.get(item.runId)
    if (!itemIds) {
      itemIds = new Set<string>()
      this.durableRunningItems.set(item.runId, itemIds)
    }
    if (itemIds.has(item.itemId)) return false
    itemIds.add(item.itemId)
    return true
  }

  private async serializeStateMutation<T>(runId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationTails.get(runId) ?? Promise.resolve()
    const pending = previous.then(mutation, mutation)
    const tail = pending.then(() => undefined, () => undefined)
    this.stateMutationTails.set(runId, tail)
    try {
      return await pending
    } finally {
      if (this.stateMutationTails.get(runId) === tail) this.stateMutationTails.delete(runId)
    }
  }
}

function orderConversationItems(items: ConversationItem[]): ConversationItem[] {
  const ordered = [...items].sort((left, right) => left.timestamp.localeCompare(right.timestamp))

  // Chat Completions 的一条 assistant 输出可以同时包含可见正文和 tool_call。
  // SDK 可能在工具已经执行后才投影完整正文；显式关系优先于到达时间。
  for (const item of [...ordered]) {
    const callId = item.metadata.assistantContentForCallId
    if (item.itemType !== 'message' || typeof callId !== 'string') continue
    const messageIndex = ordered.findIndex(candidate => candidate.itemId === item.itemId)
    const toolIndex = ordered.findIndex(candidate => (
      candidate.itemType === 'function_call' && candidate.callId === callId
    ))
    if (messageIndex < 0 || toolIndex < 0 || messageIndex < toolIndex) continue
    const [message] = ordered.splice(messageIndex, 1)
    if (!message) continue
    const nextToolIndex = ordered.findIndex(candidate => (
      candidate.itemType === 'function_call' && candidate.callId === callId
    ))
    ordered.splice(nextToolIndex, 0, message)
  }

  return ordered
}
