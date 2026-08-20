// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域日志事务语义测试
//
//   文件:       runDomainJournal.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  agentStateSchema,
  agentThreadRecordSchema,
  analysisRunSchema,
  replayRunDomainEvents,
  runDomainEventSchema,
  sessionRecordSchema,
  type RunDomainEvent,
} from '../schemas/types.js'
import { InMemoryConversationPersistence } from '../../test-support/inMemoryConversationPersistence.js'
import { RunDomainSequenceConflictError } from './storeErrors.js'

const now = '2026-08-20T00:00:00.000Z'

describe('Run domain journal', () => {
  it('maps every core Run/input/checkpoint mutation and rebuilds the stored snapshot from sequence zero', async () => {
    const persistence = await fixture()
    const run = (await persistence.loadSnapshot()).runs[0]!
    await persistence.saveRun({
      ...run,
      status: 'running',
      updatedAt: '2026-08-20T00:00:01.000Z',
      state: { ...run.state, warnings: ['started'] },
    })
    const queued = await persistence.enqueueRunInput({
      inputId: 'input_1',
      entryId: 'entry_1',
      itemId: 'item_1',
      runId: run.id,
      content: '继续分析',
    })
    await persistence.leaseRunInputs(run.id, 'lease_1')
    await persistence.saveAgentsSdkCheckpoint(run.id, {
      contentHash: 'a'.repeat(64),
      agentsSdkVersion: '0.16.1',
      runtimeConfigDigest: 'runtime_1',
      sdkStateSchemaVersion: 5,
      inputLeaseId: 'lease_1',
    })
    await persistence.enqueueRunInput({
      inputId: 'input_2',
      entryId: 'entry_2',
      itemId: 'item_2',
      runId: run.id,
      content: '先恢复再继续',
    })
    await persistence.leaseRunInputs(run.id, 'lease_2')
    await persistence.requeueLeasedRunInputs(run.id)
    await persistence.leaseRunInputs(run.id, 'lease_3')
    await persistence.saveAgentsSdkCheckpoint(run.id, {
      contentHash: 'b'.repeat(64),
      agentsSdkVersion: '0.16.1',
      runtimeConfigDigest: 'runtime_1',
      sdkStateSchemaVersion: 5,
      inputLeaseId: 'lease_3',
    })
    const beforeTool = (await persistence.loadSnapshot()).runs[0]!
    const toolRun = {
      ...beforeTool,
      updatedAt: '2026-08-20T00:00:02.000Z',
      state: { ...beforeTool.state, selectedDataSources: ['dataset_1'] },
    }
    expect(await persistence.commitToolResult(toolRun, 'result_1', [], [])).toBe(true)
    expect(await persistence.commitToolResult(toolRun, 'result_1', [], [])).toBe(false)

    const events = await persistence.listRunDomainEvents(run.id)
    const snapshot = await persistence.getRunDomainSnapshot(run.id)

    expect(queued.inputSequence).toBe(1)
    expect(events.map(event => event.type)).toEqual([
      'run.created',
      'run.checkpoint_changed',
      'run.status_changed',
      'run.state_changed',
      'input.queued',
      'run.checkpoint_changed',
      'input.leased',
      'run.checkpoint_changed',
      'input.checkpointed',
      'run.checkpoint_changed',
      'input.queued',
      'run.checkpoint_changed',
      'input.leased',
      'run.checkpoint_changed',
      'input.requeued',
      'run.checkpoint_changed',
      'input.leased',
      'run.checkpoint_changed',
      'input.checkpointed',
      'run.checkpoint_changed',
      'tool.succeeded',
    ])
    expect(replayRunDomainEvents(events)).toEqual(snapshot)
    expect(snapshot).toMatchObject({
      status: 'running',
      state: {
        warnings: ['started'],
        selectedDataSources: ['dataset_1'],
      },
      inputDeliveries: {
        input_1: { status: 'acked', leaseId: 'lease_1' },
        input_2: { status: 'acked', leaseId: 'lease_3' },
      },
      checkpoint: { checkpointInputCursor: 2, activeInputLeaseId: null },
    })
  })

  it('uses expectedSequence as a real CAS so two writers cannot both commit', async () => {
    const persistence = await fixture()
    const runId = 'run_1'
    const snapshot = await persistence.getRunDomainSnapshot(runId)
    expect(snapshot).not.toBeNull()
    const expectedSequence = snapshot!.sequence
    const writes = await Promise.allSettled([
      persistence.appendRunDomainEvents({
        runId,
        expectedSequence,
        events: [warningEvent(expectedSequence + 1, 'warning_a')],
      }),
      persistence.appendRunDomainEvents({
        runId,
        expectedSequence,
        events: [warningEvent(expectedSequence + 1, 'warning_b')],
      }),
    ])

    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = writes.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: expect.any(RunDomainSequenceConflictError) })
    const events = await persistence.listRunDomainEvents(runId)
    expect(events.at(-1)?.sequence).toBe(expectedSequence + 1)
  })

  it('rolls back a journal append that would diverge from the production Run fact', async () => {
    const persistence = await fixture()
    const before = await persistence.getRunDomainSnapshot('run_1')
    const divergent = runDomainEventSchema.parse({
      ...eventEnvelope(before!.sequence + 1, 'divergent'),
      type: 'run.status_changed',
      payload: { status: 'completed', reason: 'invalid_external_write' },
    })

    await expect(persistence.appendRunDomainEvents({
      runId: 'run_1',
      expectedSequence: before!.sequence,
      events: [divergent],
    })).rejects.toThrow(/投影与事务事实不一致/u)
    expect(await persistence.getRunDomainSnapshot('run_1')).toEqual(before)
    expect(await persistence.listRunDomainEvents('run_1')).toHaveLength(before!.sequence)
  })
})

async function fixture(): Promise<InMemoryConversationPersistence> {
  const persistence = new InMemoryConversationPersistence()
  await persistence.saveSession(sessionRecordSchema.parse({
    id: 'session_1',
    visibility: 'private',
    createdAt: now,
  }))
  await persistence.createThreadLifecycle(agentThreadRecordSchema.parse({
    id: 'thread_1',
    sessionId: 'session_1',
    visibility: 'private',
    title: '领域日志测试',
    createdAt: now,
    updatedAt: now,
  }))
  await persistence.createRunLifecycle(analysisRunSchema.parse({
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    visibility: 'private',
    userQuery: '测试',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    state: agentStateSchema.parse({
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    }),
  }))
  return persistence
}

function warningEvent(sequence: number, code: string): RunDomainEvent {
  return runDomainEventSchema.parse({
    ...eventEnvelope(sequence, code),
    type: 'projection.warning',
    payload: { code, message: code },
  })
}

function eventEnvelope(sequence: number, suffix: string) {
  return {
    eventId: `event_${suffix}`,
    runId: 'run_1',
    sequence,
    turnId: null,
    stepId: null,
    objectiveRevision: 1,
    causationId: null,
    correlationId: 'correlation_1',
    actor: { kind: 'system', id: null },
    occurredAt: `2026-08-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    schemaVersion: 1,
  }
}
