// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域日志契约与纯函数 Reducer
//
//   文件:       runDomain.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import {
  agentStateSchema,
  runStatusSchema,
  type AgentState,
} from './core.js'

export const RUN_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const
export const RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION = 1 as const

export const runDomainActorSchema = z.object({
  kind: z.enum(['user', 'agent', 'system', 'tool']),
  id: z.string().min(1).nullable(),
}).strict()

const agentStateFieldNames = Object.keys(agentStateSchema.shape) as [
  keyof AgentState & string,
  ...(keyof AgentState & string)[],
]

export const agentStateFieldSchema = z.enum(agentStateFieldNames)

// Zod object.partial() 会重新应用子 schema 的 default，不能表达精确 patch。
// 字段变更用可辨识的 field/value 序列表达，并依据 AgentState 原 schema
// 校验每个 value，避免 shadow journal 变成宽松 JSON patch。
export const agentStateFieldChangeSchema = z.object({
  field: agentStateFieldSchema,
  value: z.unknown(),
}).strict().superRefine((change, context) => {
  const fieldSchema = agentStateSchema.shape[change.field]
  const parsed = fieldSchema.safeParse(change.value)
  if (parsed.success) return
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: 'custom',
      path: ['value', ...issue.path],
      message: issue.message,
    })
  }
})

export const runDomainInputDeliverySchema = z.object({
  inputId: z.string().min(1),
  inputSequence: z.number().int().positive(),
  status: z.enum(['queued', 'leased', 'included', 'checkpointed']),
  leaseId: z.string().min(1).nullable(),
  modelRequestId: z.string().min(1).nullable(),
}).strict()

export const runDomainCheckpointSchema = z.object({
  activeEntryId: z.string().min(1).nullable(),
  pendingToolCallIds: z.array(z.string().min(1)),
  recoveryStatus: z.string().min(1),
  orchestrationEngine: z.string().min(1).nullable(),
  sdkStateContentHash: z.string().min(1).nullable(),
  agentsSdkVersion: z.string().min(1).nullable(),
  runtimeConfigDigest: z.string().min(1).nullable(),
  sdkStateSchemaVersion: z.number().int().positive().nullable(),
  nextInputSequence: z.number().int().positive(),
  checkpointInputCursor: z.number().int().nonnegative(),
  activeInputLeaseId: z.string().min(1).nullable(),
  terminalInputClaimId: z.string().min(1).nullable(),
  terminalObjectiveRevision: z.number().int().positive().nullable(),
  terminalInputCursor: z.number().int().nonnegative().nullable(),
  terminalClaimedAt: z.string().nullable(),
}).strict()

const runDomainEnvelopeShape = {
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  turnId: z.string().min(1).nullable(),
  stepId: z.string().min(1).nullable(),
  objectiveRevision: z.number().int().positive(),
  causationId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  actor: runDomainActorSchema,
  occurredAt: z.string().min(1),
  schemaVersion: z.literal(RUN_DOMAIN_EVENT_SCHEMA_VERSION),
}

const runCreatedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.created'),
  payload: z.object({
    status: runStatusSchema,
    state: agentStateSchema,
  }).strict(),
}).strict()

const runStatusChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.status_changed'),
  payload: z.object({
    status: runStatusSchema,
    reason: z.string().min(1),
  }).strict(),
}).strict()

const runStateChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.state_changed'),
  payload: z.object({
    reason: z.string().min(1),
    changes: z.array(agentStateFieldChangeSchema).min(1),
  }).strict(),
}).strict()

const toolSucceededEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('tool.succeeded'),
  payload: z.object({
    resultId: z.string().min(1),
    changes: z.array(agentStateFieldChangeSchema),
  }).strict(),
}).strict()

function inputTransitionEventSchema<
  TType extends 'input.queued' | 'input.leased' | 'input.included' | 'input.checkpointed' | 'input.requeued',
  TStatus extends 'queued' | 'leased' | 'included' | 'checkpointed',
>(type: TType, status: TStatus) {
  return z.object({
    ...runDomainEnvelopeShape,
    type: z.literal(type),
    payload: z.object({
      inputs: z.array(runDomainInputDeliverySchema.extend({ status: z.literal(status) }).strict()).min(1),
    }).strict(),
  }).strict()
}

const runCheckpointChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.checkpoint_changed'),
  payload: z.object({ checkpoint: runDomainCheckpointSchema }).strict(),
}).strict()

const projectionWarningEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('projection.warning'),
  payload: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
}).strict()

const modelRequestCommittedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('step.model_request_committed'),
  payload: z.object({
    requestId: z.string().min(1),
    stepId: z.string().min(1),
    inputObjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputEntryIds: z.array(z.string().min(1)),
  }).strict(),
}).strict()

const terminalClaimedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('terminal.claimed'),
  payload: z.object({
    claimId: z.string().min(1),
    objectiveRevision: z.number().int().positive(),
    inputCursor: z.number().int().nonnegative(),
  }).strict(),
}).strict()

const terminalCandidateSupersededEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('terminal.candidate_superseded'),
  payload: z.object({
    objectiveRevision: z.number().int().positive(),
    inputCursor: z.number().int().nonnegative(),
    durableObjectiveRevision: z.number().int().positive(),
    durableInputCursor: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const runDomainEventSchema = z.discriminatedUnion('type', [
  runCreatedEventSchema,
  runStatusChangedEventSchema,
  runStateChangedEventSchema,
  toolSucceededEventSchema,
  inputTransitionEventSchema('input.queued', 'queued'),
  inputTransitionEventSchema('input.leased', 'leased'),
  inputTransitionEventSchema('input.included', 'included'),
  inputTransitionEventSchema('input.checkpointed', 'checkpointed'),
  inputTransitionEventSchema('input.requeued', 'queued'),
  modelRequestCommittedEventSchema,
  terminalClaimedEventSchema,
  terminalCandidateSupersededEventSchema,
  runCheckpointChangedEventSchema,
  projectionWarningEventSchema,
])

export const runDomainSnapshotSchema = z.object({
  schemaVersion: z.literal(RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  status: runStatusSchema,
  state: agentStateSchema,
  inputDeliveries: z.record(z.string(), runDomainInputDeliverySchema),
  checkpoint: runDomainCheckpointSchema.nullable(),
  updatedAt: z.string().min(1),
}).strict()

export type AgentStateField = z.infer<typeof agentStateFieldSchema>
export type AgentStateFieldChange = {
  [K in keyof AgentState]: { field: K; value: AgentState[K] }
}[keyof AgentState]
export type RunDomainInputDelivery = z.infer<typeof runDomainInputDeliverySchema>
export type RunDomainCheckpoint = z.infer<typeof runDomainCheckpointSchema>
export type RunDomainEvent = z.infer<typeof runDomainEventSchema>
export type RunDomainSnapshot = z.infer<typeof runDomainSnapshotSchema>

export function reduceRunDomainEvent(
  current: RunDomainSnapshot | null,
  rawEvent: RunDomainEvent,
): RunDomainSnapshot {
  const event = runDomainEventSchema.parse(rawEvent)
  if (!current) {
    if (event.sequence !== 1 || event.type !== 'run.created') {
      throw new Error(`Run '${event.runId}' 的领域日志必须从 sequence 1 的 run.created 开始`)
    }
    return runDomainSnapshotSchema.parse({
      schemaVersion: RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION,
      runId: event.runId,
      sequence: event.sequence,
      status: event.payload.status,
      state: event.payload.state,
      inputDeliveries: {},
      checkpoint: null,
      updatedAt: event.occurredAt,
    })
  }

  const snapshot = runDomainSnapshotSchema.parse(current)
  if (event.runId !== snapshot.runId) {
    throw new Error(`Run 领域事件 '${event.eventId}' 不属于 snapshot '${snapshot.runId}'`)
  }
  if (event.sequence !== snapshot.sequence + 1) {
    throw new Error(
      `Run '${event.runId}' 领域日志 sequence 不连续：`
      + `期望 ${snapshot.sequence + 1}，收到 ${event.sequence}`,
    )
  }
  if (event.type === 'run.created') {
    throw new Error(`Run '${event.runId}' 不能重复应用 run.created`)
  }

  let status = snapshot.status
  let state = snapshot.state
  const inputDeliveries = structuredClone(snapshot.inputDeliveries)
  let checkpoint = snapshot.checkpoint

  switch (event.type) {
    case 'run.status_changed':
      status = event.payload.status
      break
    case 'run.state_changed':
    case 'tool.succeeded':
      state = applyAgentStateChanges(state, event.payload.changes)
      break
    case 'input.queued':
    case 'input.leased':
    case 'input.included':
    case 'input.checkpointed':
    case 'input.requeued':
      for (const input of event.payload.inputs) inputDeliveries[input.inputId] = input
      break
    case 'step.model_request_committed':
    case 'terminal.claimed':
    case 'terminal.candidate_superseded':
      break
    case 'run.checkpoint_changed':
      checkpoint = event.payload.checkpoint
      break
    case 'projection.warning':
      break
  }

  return runDomainSnapshotSchema.parse({
    schemaVersion: RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION,
    runId: snapshot.runId,
    sequence: event.sequence,
    status,
    state,
    inputDeliveries,
    checkpoint,
    updatedAt: event.occurredAt,
  })
}

export function reduceRunDomainEvents(
  initial: RunDomainSnapshot | null,
  events: readonly RunDomainEvent[],
): RunDomainSnapshot | null {
  return events.reduce<RunDomainSnapshot | null>(reduceRunDomainEvent, initial)
}

export function replayRunDomainEvents(events: readonly RunDomainEvent[]): RunDomainSnapshot | null {
  return reduceRunDomainEvents(null, events)
}

function applyAgentStateChanges(
  current: AgentState,
  changes: readonly z.infer<typeof agentStateFieldChangeSchema>[],
): AgentState {
  const updates: Partial<Record<keyof AgentState, unknown>> = {}
  for (const rawChange of changes) {
    const change = agentStateFieldChangeSchema.parse(rawChange)
    updates[change.field] = structuredClone(change.value)
  }
  return agentStateSchema.parse({ ...structuredClone(current), ...updates })
}
