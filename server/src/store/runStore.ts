// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行资源存储
//
//   文件:       runStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  AgentRuntimeConfig,
  AgentState,
  AgentThreadRecord,
  AnalysisRun,
  ConversationItem,
  RunCheckpoint,
  RunEvent,
  RunSummary,
  ToolValueRef,
} from '../schemas/types.js'
import { summarizeAssistantText } from '../conversation/items.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationIndexStore } from './conversationIndexStore.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { FileConversationStore } from './fileConversationStore.js'
import {
  decodeRunCursor,
  dedupeById,
  encodeRunCursor,
  isRunAfterCursor,
  toRunSummary,
} from './platformStoreUtils.js'
import type { SessionStore } from './sessionStore.js'

export interface RunStoreEvents {
  runBus: InMemoryEventBus<AnalysisRun>
  eventBus: InMemoryEventBus<RunEvent>
  itemBus: InMemoryEventBus<ConversationItem>
}

// RunStore 拥有 run manifest、checkpoint、event 和 item 追加写入。
// session/thread 上的 latest* 字段是 run 的投影，由这里同步维护。
export class RunStore {
  constructor(
    private readonly index: ConversationIndexStore,
    private readonly conversationStore: FileConversationStore,
    private readonly sessionStore: SessionStore,
    private readonly events: RunStoreEvents,
  ) {}

  listForSession(sessionId: string): AnalysisRun[] {
    return this.index.listRunsForSession(sessionId)
  }

  listForThread(threadId: string): AnalysisRun[] {
    return this.index.listRunsForThread(threadId)
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

    return {
      items: selected.map(toRunSummary),
      nextCursor: hasMore && selected.length ? encodeRunCursor(selected[selected.length - 1]) : null,
    }
  }

  get(runId: string): AnalysisRun {
    return this.index.getRun(runId)
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
        executionPlan: null,
        runLifecycle: { status: 'created', reason: null, updatedAt: null },
        failedStepId: null,
        failedTool: null,
      },
    }
    await this.conversationStore.createRun(run)
    await this.sessionStore.update(sessionId, {
      latestRunId: run.id,
      latestThreadId: thread?.id ?? session.latestThreadId,
    })
    if (thread) {
      const nextThread: AgentThreadRecord = {
        ...thread,
        latestRunId: run.id,
        latestUserQuery: query,
        latestRunStatus: run.status,
        runCount: thread.runCount + 1,
        updatedAt: now,
      }
      await this.conversationStore.saveThread(nextThread)
      this.index.setThread(nextThread)
    }
    this.index.setRun(run)
    this.events.runBus.publish(run.id, structuredClone(run))
    return run
  }

  async updateState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun> {
    const run = this.get(runId)
    const next = { ...run, state: { ...run.state, ...updates }, updatedAt: nowUtc() }
    await this.conversationStore.saveRun(next)
    this.index.setRun(next)
    this.events.runBus.publish(runId, structuredClone(next))
    return next
  }

  async updateStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun> {
    const run = this.get(runId)
    const next = { ...run, status, updatedAt: nowUtc() }
    await this.persistThreadRunStatus(run, status, next.updatedAt)
    await this.conversationStore.saveRun(next, {
      recoveryStatus: status === 'interrupted' ? 'interrupted' : status === 'requires_action' ? 'requires_action' : 'clean',
    })
    this.index.setRun(next)
    this.events.runBus.publish(runId, structuredClone(next))
    return next
  }

  async complete(runId: string, status: string): Promise<AnalysisRun> {
    const run = this.get(runId)
    const next = { ...run, status: status as AnalysisRun['status'], updatedAt: nowUtc() }
    await this.persistThreadRunStatus(run, next.status, next.updatedAt)
    await this.conversationStore.saveRun(next, {
      recoveryStatus: next.status === 'waiting_approval' || next.status === 'requires_action'
        ? 'requires_action'
        : 'clean',
    })
    await this.conversationStore.flush()
    this.index.setRun(next)
    this.events.runBus.publish(runId, structuredClone(next))
    return next
  }

  async saveCheckpoint(
    runId: string,
    fields: Partial<Pick<RunCheckpoint, 'activeEntryId' | 'pendingToolCallIds' | 'recoveryStatus'>> = {},
  ): Promise<void> {
    await this.conversationStore.saveRun(this.get(runId), fields)
  }

  async getCheckpoint(runId: string): Promise<RunCheckpoint> {
    return this.conversationStore.getRunCheckpoint(runId)
  }

  async appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void> {
    this.get(runId)
    await this.conversationStore.appendAgentTranscript(runId, agentId, record)
  }

  async saveAgentsSdkState(
    runId: string,
    serializedState: string,
    metadata: { agentsSdkVersion: string; runtimeConfigDigest: string },
  ): Promise<void> {
    this.get(runId)
    await this.conversationStore.saveAgentsSdkState(runId, serializedState, metadata)
  }

  async readAgentsSdkState(runId: string): Promise<string> {
    this.get(runId)
    return this.conversationStore.readAgentsSdkState(runId)
  }

  async appendToolValue(runId: string, value: ToolValueRef): Promise<void> {
    this.get(runId)
    await this.conversationStore.appendValue(runId, value)
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    this.get(runId)
    await this.conversationStore.appendEvent(event)
    this.events.eventBus.publish(runId, event)
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    this.get(runId)
    const persisted = await this.conversationStore.listEvents(runId)
    const current = this.events.eventBus.list(runId)
    return dedupeById([...persisted, ...current], event => event.eventId)
  }

  async appendItem(item: ConversationItem): Promise<void> {
    this.get(item.runId)
    await this.conversationStore.appendItem(item)
    this.events.itemBus.publish(item.runId, item)
    if (item.status !== 'running') await this.updateThreadProjectionFromItem(item)
  }

  async listItems(runId: string): Promise<ConversationItem[]> {
    this.get(runId)
    const persisted = await this.conversationStore.listItems(runId)
    const byItemId = new Map<string, ConversationItem>()
    for (const item of [...persisted, ...this.events.itemBus.list(runId)]) {
      byItemId.set(item.itemId, item)
    }
    return [...byItemId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  private async persistThreadRunStatus(run: AnalysisRun, status: AnalysisRun['status'], updatedAt: string): Promise<void> {
    if (!run.threadId) return
    const thread = this.index.getThreadOrNull(run.threadId)
    if (!thread) return
    const nextThread = { ...thread, latestRunStatus: status, updatedAt }
    await this.conversationStore.saveThread(nextThread)
    this.index.setThread(nextThread)
  }

  private async updateThreadProjectionFromItem(item: ConversationItem): Promise<void> {
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
    await this.conversationStore.saveThread(next)
    this.index.setThread(next)
  }
}
