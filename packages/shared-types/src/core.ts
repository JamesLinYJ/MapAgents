// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 核心协议
//
//   文件:       core.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Agent 核心协议：运行状态、决策、事件与实时对话项。
import { z } from 'zod'
import { artifactDisplaySchema } from './map.js'

// --- Enums ---

export const eventTypeSchema = z.enum([
  'intent.parsed', 'plan.ready', 'step.started', 'step.completed',
  'agent_workflow.created', 'agent_workflow.revised', 'agent_workflow.completed',
  'artifact.created', 'subagent.created', 'subagent.updated',
  'loop.updated', 'todo.updated', 'tool.started', 'tool.completed',
  'clarification.required', 'approval.required', 'warning.raised',
  'trace.recorded',
  'run.completed', 'run.failed',
])

export const runStatusSchema = z.enum([
  'queued', 'running', 'clarification_needed', 'waiting_approval',
  'completed', 'failed', 'cancelled', 'interrupted', 'requires_action',
])

export const todoStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'blocked'])

export const conversationItemTypeSchema = z.enum([
  'message', 'reasoning', 'function_call', 'function_call_output', 'result', 'error',
])

// --- Core Models ---

export const clarificationOptionSchema = z.object({
  optionId: z.string().nullable().default(null),
  label: z.string(),
  description: z.string().default(''),
  kind: z.string().default('generic'),
  reason: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).prefault({}),
})

export const clarificationStateSchema = z.object({
  clarificationId: z.string(),
  kind: z.string().default('generic'),
  reason: z.string().default('generic'),
  question: z.string(),
  options: z.array(clarificationOptionSchema).default([]),
  selectedOptionId: z.string().nullable().default(null),
  allowFreeText: z.boolean().default(true),
})

export const decisionRequestSchema = z.object({
  decisionId: z.string(),
  kind: z.enum(['execution_mode', 'clarification', 'approval']),
  title: z.string(),
  question: z.string(),
  description: z.string().default(''),
  options: z.array(clarificationOptionSchema).default([]),
  allowFreeText: z.boolean().default(false),
  status: z.string().default('pending'),
  payload: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
})

export const placeSearchCandidateSchema = z.object({
  label: z.string(),
  displayName: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  boundingbox: z.array(z.union([z.string(), z.number()])).nullable().default(null),
  source: z.string().nullable().default(null),
})

export const placeResolutionSchema = z.object({
  status: z.string().default('unresolved'),
  query: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  selected: placeSearchCandidateSchema.nullable().default(null),
  candidates: z.array(placeSearchCandidateSchema).default([]),
  error: z.string().nullable().default(null),
})

export const userIntentSchema = z.object({
  area: z.string().nullable().default(null),
  placeQuery: z.string().nullable().default(null),
  anchorType: z.string().default('unknown'),
  taskType: z.string().nullable().default(null),
  distanceM: z.number().nullable().default(null),
  publishRequested: z.boolean().default(false),
  dataRequirements: z.array(z.string()).default([]),
  targetLayers: z.array(z.string()).default([]),
  spatialConstraints: z.array(z.string()).default([]),
  desiredOutputs: z.array(z.string()).default([]),
  uncertaintyFlags: z.array(z.string()).default([]),
  clarificationRequired: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null),
  clarificationOptions: z.array(clarificationOptionSchema).default([]),
})

export const agentWorkflowStepKindSchema = z.enum(['analysis', 'tool', 'agent', 'automation', 'delivery'])
export const agentWorkflowStepStatusSchema = z.enum([
  'pending', 'running', 'completed', 'failed', 'blocked', 'skipped',
])
export const agentWorkflowStatusSchema = z.enum([
  'awaiting_approval', 'running', 'adjusting', 'completed', 'failed', 'cancelled',
])

export const agentWorkflowStepDraftSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  kind: agentWorkflowStepKindSchema,
  toolName: z.string().min(1),
  ownerAgentId: z.string().min(1).default('supervisor'),
  args: z.record(z.string(), z.unknown()).prefault({}),
  reason: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
}).superRefine((step, context) => {
  if (step.kind === 'automation' && step.toolName !== 'execute_automation') {
    context.addIssue({
      code: 'custom',
      path: ['toolName'],
      message: 'Automation 步骤必须通过 execute_automation 执行。',
    })
  }
  if (step.kind === 'agent' && (!step.ownerAgentId || step.ownerAgentId !== step.toolName)) {
    context.addIssue({
      code: 'custom',
      path: ['ownerAgentId'],
      message: '子智能体步骤的 ownerAgentId 必须与 Agent 工具名一致。',
    })
  }
  if (step.kind !== 'agent' && step.ownerAgentId !== 'supervisor') {
    context.addIssue({
      code: 'custom',
      path: ['ownerAgentId'],
      message: "非子智能体步骤的 ownerAgentId 必须为 'supervisor'。",
    })
  }
})

export const agentWorkflowStepSchema = agentWorkflowStepDraftSchema.safeExtend({
  status: agentWorkflowStepStatusSchema.default('pending'),
  attempt: z.number().int().nonnegative().default(0),
  resultSummary: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
})

export const agentWorkflowDraftSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(agentWorkflowStepDraftSchema).min(1),
})

export const agentWorkflowRevisionSchema = agentWorkflowDraftSchema.extend({
  changeReason: z.string().min(1),
})

export const agentWorkflowSchema = z.object({
  agentWorkflowId: z.string().min(1),
  revision: z.number().int().positive(),
  goal: z.string().min(1),
  status: agentWorkflowStatusSchema,
  changeReason: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  steps: z.array(agentWorkflowStepSchema).min(1),
}).superRefine((workflow, context) => {
  const ids = new Set(workflow.steps.map(step => step.stepId))
  if (ids.size !== workflow.steps.length) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '智能体工作流步骤 ID 必须唯一。' })
  }
  workflow.steps.forEach((step, index) => {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'dependsOn'], message: `依赖步骤 '${dependency}' 不存在。` })
      }
      if (dependency === step.stepId) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'dependsOn'], message: '步骤不能依赖自身。' })
      }
    }
  })
})

export const toolValueRefSchema = z.object({
  refId: z.string(),
  kind: z.string(),
  label: z.string(),
  value: z.unknown(),
  unit: z.string().nullable().default(null),
  sourceTool: z.string().nullable().default(null),
  sourceResultId: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string().nullable().default(null),
})

export const toolCallSchema = z.object({
  stepId: z.string(),
  tool: z.string(),
  toolLabel: z.string().nullable().default(null),
  args: z.record(z.string(), z.unknown()).prefault({}),
  status: z.string(),
  message: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  resultId: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  usedQuery: z.string().nullable().default(null),
  provenance: z.record(z.string(), z.unknown()).prefault({}),
  crs: z.record(z.string(), z.unknown()).prefault({}),
  geometryType: z.string().nullable().default(null),
  featureCount: z.number().nullable().default(null),
  valueRefs: z.array(toolValueRefSchema).default([]),
})

export const contextReferenceSchema = z.object({
  referenceId: z.string(),
  kind: z.string(),
  label: z.string(),
  description: z.string().default(''),
  sourceRunId: z.string().nullable().default(null),
  artifactId: z.string().nullable().default(null),
  collectionRef: z.string().nullable().default(null),
  layerKey: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  usableAs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
})

export const contextResolutionSchema = z.object({
  status: z.string().default('unresolved'),
  query: z.string().nullable().default(null),
  selectedReferenceId: z.string().nullable().default(null),
  selectedKind: z.string().nullable().default(null),
  sourceRunId: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  candidates: z.array(contextReferenceSchema).default([]),
})

export const memoryScopeSchema = z.enum(['private', 'team', 'session', 'instruction'])
export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])
export const memoryFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: memoryTypeSchema,
  paths: z.union([z.string(), z.array(z.string())]).optional(),
})
export const memoryFileRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  scope: memoryScopeSchema,
  type: memoryTypeSchema.nullable().default(null),
  name: z.string().default(''),
  description: z.string().default(''),
  mtimeMs: z.number().nonnegative().default(0),
  content: z.string().optional(),
  parent: z.string().nullable().default(null),
  globs: z.array(z.string()).default([]),
  contentDiffersFromDisk: z.boolean().default(false),
})
export const memorySearchResultSchema = z.object({
  record: memoryFileRecordSchema,
  reason: z.string().default(''),
  score: z.number().min(0).max(1).default(0),
})
export const memoryOperationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  record: memoryFileRecordSchema.nullable().default(null),
  records: z.array(memoryFileRecordSchema).default([]),
  results: z.array(memorySearchResultSchema).default([]),
})

export const runLifecycleSchema = z.object({
  status: z.string().default('created'),
  reason: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const todoItemSchema = z.object({
  todoId: z.string(),
  title: z.string(),
  status: todoStatusSchema.default('pending'),
  description: z.string().nullable().default(null),
  activeForm: z.string().nullable().default(null),
  ownerAgentId: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
})

export const taskRecordSchema = z.object({
  taskId: z.string(),
  agentType: z.string(),
  prompt: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).default('pending'),
  createdAt: z.string(),
  updatedAt: z.string().nullable().default(null),
  resultSummary: z.string().nullable().default(null),
})

export const subAgentStateSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string().default('pending'),
  summary: z.string().default(''),
  stepIds: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  currentStepId: z.string().nullable().default(null),
  latestMessage: z.string().nullable().default(null),
})

export const approvalRequestSchema = z.object({
  approvalId: z.string(),
  action: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string().default('pending'),
  artifactId: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
})

export const artifactRefSchema = z.object({
  artifactId: z.string(),
  runId: z.string(),
  artifactType: z.string(),
  name: z.string(),
  uri: z.string(),
  display: artifactDisplaySchema,
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  isIntermediate: z.boolean().default(false),
})

export const loopTraceEntrySchema = z.object({
  iteration: z.number(),
  phase: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string().default('running'),
  timestamp: z.string(),
  agentId: z.string().nullable().default(null),
  toolName: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
})

export const agentStateSchema = z.object({
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  parsedIntent: userIntentSchema.nullable().default(null),
  clarification: clarificationStateSchema.nullable().default(null),
  placeResolution: placeResolutionSchema.nullable().default(null),
  contextReferences: z.array(contextReferenceSchema).default([]),
  contextResolution: contextResolutionSchema.nullable().default(null),
  runLifecycle: runLifecycleSchema.default({ status: 'created', reason: null, updatedAt: null }),
  agentWorkflow: agentWorkflowSchema.nullable().default(null),
  currentStep: z.number().default(0),
  loopIteration: z.number().default(0),
  loopPhase: z.string().default('idle'),
  loopTrace: z.array(loopTraceEntrySchema).default([]),
  todos: z.array(todoItemSchema).default([]),
  tasks: z.array(taskRecordSchema).default([]),
  planMode: z.boolean().default(false),
  subAgents: z.array(subAgentStateSchema).default([]),
  activeSkills: z.array(z.string()).default([]),
  activeMcpServers: z.array(z.string()).default([]),
  decisions: z.array(decisionRequestSchema).default([]),
  approvals: z.array(approvalRequestSchema).default([]),
  toolResults: z.array(toolCallSchema).default([]),
  toolValueRefs: z.array(toolValueRefSchema).default([]),
  artifacts: z.array(artifactRefSchema).default([]),
  selectedDataSources: z.array(z.string()).default([]),
  planRepairAttempts: z.number().default(0),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  failedStepId: z.string().nullable().default(null),
  failedTool: z.string().nullable().default(null),
  denialCounts: z.record(z.string(), z.number()).prefault({}),
  runtimeStats: z.record(z.string(), z.number()).prefault({}),
})

export const runEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  type: eventTypeSchema,
  message: z.string(),
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()).prefault({}),
})

export const conversationItemSchema = z.object({
  itemId: z.string(),
  itemType: conversationItemTypeSchema,
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  callId: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  arguments: z.string().nullable().default(null),
  output: z.string().nullable().default(null),
  isError: z.boolean().default(false),
  phase: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  timestamp: z.string(),
})

export const runSteeringStatusSchema = z.enum(['queued', 'consumed', 'rejected'])

// 运行中引导消息使用 append-only 状态记录。相同 steeringId 的最后一条记录
// 是当前状态；entryId/itemId 在排队时确定，使重试和崩溃恢复保持幂等。
export const runSteeringRecordSchema = z.object({
  schemaVersion: z.literal(1),
  steeringId: z.string().min(1),
  entryId: z.string().min(1),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  content: z.string().min(1),
  status: runSteeringStatusSchema,
  queuedAt: z.string(),
  consumedAt: z.string().nullable().default(null),
})

export type EventType = z.infer<typeof eventTypeSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type TodoStatus = z.infer<typeof todoStatusSchema>
export type ConversationItemType = z.infer<typeof conversationItemTypeSchema>
export type ClarificationOption = z.infer<typeof clarificationOptionSchema>
export type ClarificationState = z.infer<typeof clarificationStateSchema>
export type DecisionRequest = z.infer<typeof decisionRequestSchema>
export type PlaceSearchCandidate = z.infer<typeof placeSearchCandidateSchema>
export type PlaceResolution = z.infer<typeof placeResolutionSchema>
export type UserIntent = z.infer<typeof userIntentSchema>
export type AgentWorkflowStep = z.infer<typeof agentWorkflowStepSchema>
export type AgentWorkflowDraft = z.infer<typeof agentWorkflowDraftSchema>
export type AgentWorkflowRevision = z.infer<typeof agentWorkflowRevisionSchema>
export type AgentWorkflow = z.infer<typeof agentWorkflowSchema>
export type ToolValueRef = z.infer<typeof toolValueRefSchema>
export type ToolCall = z.infer<typeof toolCallSchema>
export type ContextReference = z.infer<typeof contextReferenceSchema>
export type ContextResolution = z.infer<typeof contextResolutionSchema>
export type MemoryScope = z.infer<typeof memoryScopeSchema>
export type MemoryType = z.infer<typeof memoryTypeSchema>
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>
export type MemoryFileRecord = z.infer<typeof memoryFileRecordSchema>
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>
export type MemoryOperationResult = z.infer<typeof memoryOperationResultSchema>
export type RunLifecycle = z.infer<typeof runLifecycleSchema>
export type TodoItem = z.infer<typeof todoItemSchema>
export type TaskRecord = z.infer<typeof taskRecordSchema>
export type SubAgentState = z.infer<typeof subAgentStateSchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type ArtifactRef = z.infer<typeof artifactRefSchema>
export type LoopTraceEntry = z.infer<typeof loopTraceEntrySchema>
export type AgentState = z.infer<typeof agentStateSchema>
export type RunEvent = z.infer<typeof runEventSchema>
export type ConversationItem = z.infer<typeof conversationItemSchema>
export type RunSteeringStatus = z.infer<typeof runSteeringStatusSchema>
export type RunSteeringRecord = z.infer<typeof runSteeringRecordSchema>
