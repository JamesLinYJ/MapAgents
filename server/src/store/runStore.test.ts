import { describe, expect, it, vi } from 'vitest'

import type { AgentThreadRecord, AnalysisRun, ConversationItem, SessionRecord } from '../schemas/types.js'
import { ConversationIndexStore } from './conversationIndexStore.js'
import { InMemoryEventBus } from './eventBus.js'
import type { FileConversationStore } from './fileConversationStore.js'
import { RunStore } from './runStore.js'
import type { SessionStore } from './sessionStore.js'
import type { ConversationRepository } from './postgres/conversationRepository.js'

function createRunStore(overrides: Partial<FileConversationStore> = {}) {
  const index = new ConversationIndexStore()
  const session: SessionRecord = {
    id: 'session_1',
    title: '测试会话',
    status: 'active',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    latestThreadId: 'thread_1',
    latestRunId: 'run_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    latestMeteorologicalDatasetId: null,
  } as SessionRecord
  const thread: AgentThreadRecord = {
    id: 'thread_1',
    sessionId: 'session_1',
    title: '测试线程',
    status: 'active',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    runCount: 1,
    latestRunId: 'run_1',
    latestRunStatus: 'running',
    latestUserQuery: '测试',
    latestAssistantSummary: null,
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    latestMeteorologicalDatasetId: null,
  } as AgentThreadRecord
  const run: AnalysisRun = {
    id: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    userQuery: '测试',
    modelProvider: 'openai_compatible',
    modelName: null,
    status: 'running',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    conversationPath: null,
    runtimeConfigSnapshot: null,
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
      modelProvider: 'openai_compatible',
      modelName: null,
      parsedIntent: null,
      clarification: null,
      placeResolution: null,
      contextReferences: [],
      contextResolution: null,
      runLifecycle: { status: 'created', reason: null, updatedAt: null },
      executionPlan: null,
      currentStep: 0,
      loopIteration: 0,
      loopPhase: 'idle',
      loopTrace: [],
      todos: [],
      tasks: [],
      planMode: false,
      subAgents: [],
      activeSkills: [],
      activeMcpServers: [],
      decisions: [],
      approvals: [],
      toolResults: [],
      toolValueRefs: [],
      artifacts: [],
      selectedDataSources: [],
      warnings: [],
      errors: [],
      failedStepId: null,
      failedTool: null,
      denialCounts: {},
      runtimeStats: {},
      planRepairAttempts: 0,
    },
  } as AnalysisRun
  index.load({ sessions: [session], threads: [thread], runs: [run] })
  const conversationStore = {
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FileConversationStore
  const repository = {
    saveRun: vi.fn().mockResolvedValue(undefined),
    saveRunWithCheckpoint: vi.fn().mockResolvedValue(undefined),
    saveRunCheckpoint: vi.fn().mockResolvedValue(undefined),
    saveThread: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    appendConversationItem: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConversationRepository
  const itemBus = new InMemoryEventBus<ConversationItem>()
  const store = new RunStore(
    index,
    conversationStore,
    {} as SessionStore,
    repository,
    {
      runBus: new InMemoryEventBus<AnalysisRun>(),
      eventBus: new InMemoryEventBus(),
      itemBus,
    },
  )
  return { store, index, conversationStore, repository, itemBus }
}

describe('RunStore projections', () => {
  it('persists terminal run status even when thread status projection fails', async () => {
    const { store, index, conversationStore, repository } = createRunStore()

    const completed = await store.complete('run_1', 'completed')

    expect(completed.status).toBe('completed')
    expect(index.getRun('run_1').status).toBe('completed')
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      { recoveryStatus: 'clean' },
    )
    expect(repository.saveThread).toHaveBeenCalled()
  })

  it('updates the in-memory thread summary after the repository transaction commits', async () => {
    const { store, index, repository } = createRunStore()

    await expect(store.appendItem({
      itemId: 'item_1',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: '最终回答',
      name: null,
      arguments: null,
      output: null,
      turnId: null,
      callId: null,
      phase: null,
      status: 'completed',
      isError: false,
      metadata: {},
      timestamp: '2026-07-09T00:00:01.000Z',
    })).resolves.toBeUndefined()

    expect(repository.appendConversationItem).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item_1' }))
    expect(index.getThread('thread_1').latestAssistantSummary).toBe('最终回答')
  })

  it('persists only the first running snapshot and the terminal item state', async () => {
    const { store, repository, itemBus } = createRunStore()
    const liveItems: ConversationItem[] = []
    itemBus.subscribe('run_1', item => liveItems.push(item))
    const base: ConversationItem = {
      itemId: 'item_stream_1',
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: '',
      name: null,
      arguments: null,
      output: null,
      turnId: null,
      callId: null,
      phase: null,
      status: 'running',
      isError: false,
      metadata: {},
      timestamp: '2026-07-09T00:00:01.000Z',
    }

    await store.appendItem(base)
    await store.appendItem({ ...base, body: '第一段' })
    await store.appendItem({ ...base, body: '第一段第二段' })
    await store.appendItem({ ...base, body: '最终回答', status: 'completed' })

    expect(repository.appendConversationItem).toHaveBeenCalledTimes(2)
    expect(repository.appendConversationItem).toHaveBeenNthCalledWith(1, base)
    expect(repository.appendConversationItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: '最终回答', status: 'completed' }),
    )
    expect(liveItems.map(item => item.body)).toEqual(['', '第一段', '第一段第二段', '最终回答'])
  })
})
