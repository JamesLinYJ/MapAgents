// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域日志契约测试
//
//   文件:       runDomain.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { agentStateSchema } from './core.js'
import {
  reduceRunDomainEvent,
  replayRunDomainEvents,
  runDomainEventSchema,
  type RunDomainEvent,
} from './runDomain.js'

const initialState = agentStateSchema.parse({
  sessionId: 'session_1',
  userQuery: '绘制风险区划图',
})

describe('run domain journal contract', () => {
  it('rebuilds a snapshot from sequence zero without reading AgentState storage', () => {
    const events = [
      event(1, 'run.created', { status: 'queued', state: initialState }),
      event(2, 'run.status_changed', { status: 'running', reason: 'runner_started' }),
      event(3, 'run.state_changed', {
        reason: 'runtime_progress',
        changes: [
          { field: 'warnings', value: ['运行中警告'] },
          { field: 'currentStep', value: 2 },
        ],
      }),
      event(4, 'input.queued', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'queued',
          leaseId: null,
          modelRequestId: null,
        }],
      }),
      event(5, 'input.leased', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'leased',
          leaseId: 'lease_1',
          modelRequestId: null,
        }],
      }),
      event(6, 'input.included', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'included',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        }],
      }),
      event(7, 'step.model_request_committed', {
        requestId: 'model_request_1',
        stepId: 'step_1',
        inputObjectHash: 'b'.repeat(64),
        inputEntryIds: ['entry_1'],
      }),
      event(8, 'input.checkpointed', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'checkpointed',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        }],
      }),
      event(9, 'run.checkpoint_changed', {
        checkpoint: {
          activeEntryId: null,
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
          orchestrationEngine: 'openai_agents',
          sdkStateContentHash: 'a'.repeat(64),
          agentsSdkVersion: '0.16.1',
          runtimeConfigDigest: 'digest_1',
          sdkStateSchemaVersion: 5,
          nextInputSequence: 2,
          checkpointInputCursor: 1,
          activeInputLeaseId: null,
          terminalInputClaimId: null,
          terminalObjectiveRevision: null,
          terminalInputCursor: null,
          terminalClaimedAt: null,
        },
      }),
    ]

    const replayed = replayRunDomainEvents(events)

    expect(replayed).toMatchObject({
      runId: 'run_1',
      sequence: 9,
      status: 'running',
      state: { warnings: ['运行中警告'], currentStep: 2 },
      inputDeliveries: {
        input_1: {
          status: 'checkpointed',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        },
      },
      checkpoint: { checkpointInputCursor: 1 },
    })
  })

  it('produces the same snapshot incrementally and by full replay', () => {
    const events = [
      event(1, 'run.created', { status: 'queued', state: initialState }),
      event(2, 'tool.succeeded', {
        resultId: 'result_1',
        changes: [{ field: 'selectedDataSources', value: ['dataset_1'] }],
      }),
      event(3, 'run.status_changed', { status: 'completed', reason: 'terminal_committed' }),
    ]
    const incremental = events.reduce(reduceRunDomainEvent, null)

    expect(incremental).toEqual(replayRunDomainEvents(events))
    expect(incremental?.state.selectedDataSources).toEqual(['dataset_1'])
  })

  it('rejects non-contiguous sequences and duplicate run creation', () => {
    const created = reduceRunDomainEvent(
      null,
      event(1, 'run.created', { status: 'queued', state: initialState }),
    )

    expect(() => reduceRunDomainEvent(
      created,
      event(3, 'run.status_changed', { status: 'running', reason: 'skipped_sequence' }),
    )).toThrow(/sequence 不连续/u)
    expect(() => reduceRunDomainEvent(
      created,
      event(2, 'run.created', { status: 'queued', state: initialState }),
    )).toThrow(/不能重复/u)
  })

  it('validates each AgentState field change with the canonical field schema', () => {
    const invalid = {
      ...envelope(2),
      type: 'run.state_changed',
      payload: {
        reason: 'invalid_patch',
        changes: [{ field: 'warnings', value: [123] }],
      },
    }

    expect(runDomainEventSchema.safeParse(invalid).success).toBe(false)
  })
})

function event(
  sequence: number,
  type: RunDomainEvent['type'],
  payload: unknown,
): RunDomainEvent {
  return runDomainEventSchema.parse({ ...envelope(sequence), type, payload })
}

function envelope(sequence: number) {
  return {
    eventId: `event_${sequence}`,
    runId: 'run_1',
    sequence,
    turnId: null,
    stepId: null,
    objectiveRevision: 1,
    causationId: null,
    correlationId: 'correlation_1',
    actor: { kind: 'system', id: null },
    occurredAt: `2026-08-20T00:00:0${sequence}.000Z`,
    schemaVersion: 1,
  }
}
