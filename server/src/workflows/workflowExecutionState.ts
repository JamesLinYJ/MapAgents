import { z } from 'zod'
import { workflowApprovalRequestSchema, workflowDefinitionSchema, workflowNodeRunSchema, type WorkflowDefinition } from './schemas.js'

export const workflowExecutionStateSchema = z.object({
  definitionSnapshot: workflowDefinitionSchema,
  prompt: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  sessionId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  orchestrationRunId: z.string().nullable().default(null),
  nodeOutputs: z.record(z.string(), z.record(z.string(), z.unknown())).prefault({}),
  selectedPorts: z.record(z.string(), z.array(z.string())).prefault({}),
  approvedNodeIds: z.array(z.string()).default([]),
  currentAgentRunId: z.string().nullable().default(null),
  nodeRuns: z.array(workflowNodeRunSchema),
  pendingApproval: workflowApprovalRequestSchema.nullable().default(null),
})

export type WorkflowExecutionState = z.infer<typeof workflowExecutionStateSchema>

export function createWorkflowExecutionState(input: {
  definition: WorkflowDefinition
  prompt: string
  parameters: Record<string, unknown>
}): WorkflowExecutionState {
  return workflowExecutionStateSchema.parse({
    definitionSnapshot: structuredClone(input.definition),
    prompt: input.prompt,
    parameters: structuredClone(input.parameters),
    sessionId: null,
    threadId: null,
    orchestrationRunId: null,
    nodeOutputs: {},
    selectedPorts: {},
    approvedNodeIds: [],
    currentAgentRunId: null,
    nodeRuns: input.definition.graph.nodes.map(node => ({
      nodeId: node.nodeId,
      nodeType: node.type,
      label: node.label,
      status: 'pending',
      attempt: 0,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      output: {},
    })),
    pendingApproval: null,
  })
}

export function parseWorkflowExecutionState(metadata: Record<string, unknown>): WorkflowExecutionState {
  return workflowExecutionStateSchema.parse(metadata.executionState)
}

export function withExecutionState(
  metadata: Record<string, unknown>,
  executionState: WorkflowExecutionState,
): Record<string, unknown> {
  return {
    ...metadata,
    executionState: structuredClone(executionState),
  }
}
