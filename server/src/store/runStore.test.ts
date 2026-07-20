// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运行资源存储测试
//
//   文件:       runStore.test.ts
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { AgentThreadRecord, AnalysisRun, ConversationItem, SessionRecord } from '../schemas/types.js'
import { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import { InMemoryEventBus } from './eventBus.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'
import { RunStore } from './runStore.js'
import type { SessionStore } from './sessionStore.js'
import type { ConversationPersistence } from './postgres/conversationPersistencePorts.js'

function createRunStore(overrides: Partial<ConversationPayloadStore> = {}) {
  const index = new ConversationProjectionIndex()
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
    modelProvider: 'deepseek',
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
      modelProvider: 'deepseek',
      modelName: null,
      parsedIntent: null,
      clarification: null,
      placeResolution: null,
      contextReferences: [],
      contextResolution: null,
      runLifecycle: { status: 'created', reason: null, updatedAt: null },
      agentWorkflow: null,
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
  const payloadStore = {
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ConversationPayloadStore
  const repository = {
    saveRun: vi.fn().mockResolvedValue(undefined),
    saveRunWithCheckpoint: vi.fn().mockResolvedValue(undefined),
    saveRunCheckpoint: vi.fn().mockResolvedValue(undefined),
    getRunCheckpoint: vi.fn().mockResolvedValue({
      pendingToolCallIds: [],
      recoveryStatus: 'clean',
    }),
    saveThread: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    appendConversationItem: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConversationPersistence
  const itemBus = new InMemoryEventBus<ConversationItem>()
  const store = new RunStore(
    index,
    payloadStore,
    {} as SessionStore,
    repository,
    repository,
    {
      runBus: new InMemoryEventBus<AnalysisRun>(),
      eventBus: new InMemoryEventBus(),
      itemBus,
    },
  )
  return { store, index, payloadStore, repository, itemBus }
}

describe('RunStore projections', () => {
  it('serializes concurrent state read-modify-write operations for one run', async () => {
    const { store, index, repository } = createRunStore()
    let releaseFirstSave: (() => void) | null = null
    vi.mocked(repository.saveRun)
      .mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirstSave = resolve }))
      .mockResolvedValue(undefined)

    const first = store.updateState('run_1', { warnings: ['第一条警告'] })
    await vi.waitFor(() => expect(repository.saveRun).toHaveBeenCalledTimes(1))
    const second = store.updateState('run_1', { errors: ['第二条错误'] })
    await Promise.resolve()

    expect(repository.saveRun).toHaveBeenCalledTimes(1)
    if (!releaseFirstSave) throw new Error('首个状态写入没有进入等待态')
    releaseFirstSave()
    await Promise.all([first, second])

    expect(index.getRun('run_1').state).toMatchObject({
      warnings: ['第一条警告'],
      errors: ['第二条错误'],
    })
    expect(repository.saveRun).toHaveBeenCalledTimes(2)
  })

  it('applies atomic mutations against the latest serialized state', async () => {
    const { store, index } = createRunStore()

    await Promise.all([
      store.mutateState('run_1', state => ({ warnings: [...state.warnings, 'A'] })),
      store.mutateState('run_1', state => ({ warnings: [...state.warnings, 'B'] })),
    ])

    expect(index.getRun('run_1').state.warnings).toEqual(['A', 'B'])
  })

  it('marks an orphaned active run as interrupted during startup recovery', async () => {
    const { store, index, repository } = createRunStore()

    const recovered = await store.recoverOrphanedRuns()

    expect(recovered).toHaveLength(1)
    expect(index.getRun('run_1')).toMatchObject({
      status: 'interrupted',
      state: {
        runLifecycle: { status: 'interrupted' },
        warnings: [expect.stringContaining('服务进程重启')],
      },
    })
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
      { pendingToolCallIds: [], recoveryStatus: 'interrupted' },
    )
  })

  it('requires manual action when an orphaned run has an unknown tool state', async () => {
    const { store, index, repository } = createRunStore()
    vi.mocked(repository.getRunCheckpoint).mockResolvedValue({
      pendingToolCallIds: ['call_unknown'],
      recoveryStatus: 'requires_action',
    } as never)

    await store.recoverOrphanedRuns()

    expect(index.getRun('run_1').status).toBe('requires_action')
    expect(repository.saveRunWithCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'requires_action' }),
      { pendingToolCallIds: ['call_unknown'], recoveryStatus: 'requires_action' },
    )
  })

  it('persists terminal run status even when thread status projection fails', async () => {
    const { store, index, payloadStore, repository } = createRunStore()

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
