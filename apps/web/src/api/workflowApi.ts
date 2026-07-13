// GeoForge Workflow Studio、运行、审批、定时任务和后台任务传输边界。

import {
  backgroundTaskInfoSchema,
  scheduledTaskSchema,
  workflowDefinitionSchema,
  workflowRunRecordSchema,
  workflowValidationResultSchema,
  workflowVersionRecordSchema,
  type BackgroundTaskInfo,
  type ScheduledTask,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowRunRecord,
  type WorkflowValidationResult,
  type WorkflowVersionRecord,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'
import {
  backgroundTaskListResponseSchema,
  scheduledTaskListResponseSchema,
  workflowListResponseSchema,
} from './responseSchemas'
import { requestControl } from './transport'

export interface WorkflowDraftPayload {
  workflowId?: string
  name: string
  description: string
  version: string
  parametersSchema: Record<string, unknown>
  defaultParameters: Record<string, unknown>
  timeoutSeconds: number
  outputType: string
  graph: WorkflowGraph
}

export interface WorkflowUpdatePayload extends WorkflowDraftPayload {
  workflowId: string
  expectedRevision: number
}

export interface StartWorkflowPayload {
  workflowId: string
  prompt: string
  parameters?: Record<string, unknown>
}

export interface ScheduledTaskCreatePayload {
  targetKind: 'workflow'
  targetId: string
  title?: string | null
  prompt: string
  parameters?: Record<string, unknown>
  cron: string
  timezone: string
  recurring?: boolean
  enabled?: boolean
}

export interface ScheduledTaskUpdatePayload extends Partial<ScheduledTaskCreatePayload> {
  taskId: string
}

const workflowStartResponseSchema = z.object({
  workflowRun: workflowRunRecordSchema,
  jobId: z.string(),
})
const workflowApprovalResponseSchema = z.object({
  workflowRun: workflowRunRecordSchema,
  jobId: z.string().nullable(),
})

export function listWorkflows(): Promise<{
  definitions: WorkflowDefinition[]
  diagnostics: Array<Record<string, unknown>>
  validation: Record<string, WorkflowValidationResult>
}> {
  return requestControl('workflow:list', {}, workflowListResponseSchema)
}

export function validateWorkflow(payload: WorkflowDraftPayload): Promise<WorkflowValidationResult> {
  return requestControl('workflow:validate', { ...payload }, workflowValidationResultSchema)
}

export function createWorkflow(payload: WorkflowDraftPayload): Promise<WorkflowDefinition> {
  return requestControl('workflow:create', { ...payload }, workflowDefinitionSchema)
}

export function updateWorkflow(payload: WorkflowUpdatePayload): Promise<WorkflowDefinition> {
  return requestControl('workflow:update', { ...payload }, workflowDefinitionSchema)
}

export function publishWorkflow(workflowId: string, revision: number): Promise<WorkflowDefinition> {
  return requestControl('workflow:publish', { workflowId, revision }, workflowDefinitionSchema)
}

export function disableWorkflow(workflowId: string): Promise<WorkflowDefinition> {
  return requestControl('workflow:disable', { workflowId }, workflowDefinitionSchema)
}

export function getWorkflowHistory(workflowId: string): Promise<WorkflowVersionRecord[]> {
  return requestControl('workflow:history', { workflowId }, z.array(workflowVersionRecordSchema))
}

export function startWorkflow(payload: StartWorkflowPayload): Promise<z.infer<typeof workflowStartResponseSchema>> {
  return requestControl('workflow:start', { ...payload }, workflowStartResponseSchema)
}

export function cancelWorkflow(workflowRunId: string): Promise<WorkflowRunRecord> {
  return requestControl('workflow:cancel', { workflowRunId }, workflowRunRecordSchema)
}

export function getWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord> {
  return requestControl('workflow:run:get', { workflowRunId }, workflowRunRecordSchema)
}

export function respondWorkflowApproval(
  workflowRunId: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<z.infer<typeof workflowApprovalResponseSchema>> {
  return requestControl('workflow:respond-approval', { workflowRunId, approvalId, decision }, workflowApprovalResponseSchema)
}

export function listScheduledTasks(): Promise<{ tasks: ScheduledTask[]; workflowRuns: WorkflowRunRecord[] }> {
  return requestControl('scheduled-task:list', {}, scheduledTaskListResponseSchema)
}

export function createScheduledTask(payload: ScheduledTaskCreatePayload): Promise<ScheduledTask> {
  return requestControl('scheduled-task:create', { ...payload }, scheduledTaskSchema)
}

export function updateScheduledTask(payload: ScheduledTaskUpdatePayload): Promise<ScheduledTask> {
  return requestControl('scheduled-task:update', { ...payload }, scheduledTaskSchema)
}

export function deleteScheduledTask(taskId: string): Promise<ScheduledTask> {
  return requestControl('scheduled-task:delete', { taskId }, scheduledTaskSchema)
}

export function listBackgroundTasks(): Promise<{ tasks: BackgroundTaskInfo[] }> {
  return requestControl('background-task:list', {}, backgroundTaskListResponseSchema)
}

export function promoteBackgroundTask(taskId: string): Promise<BackgroundTaskInfo> {
  return requestControl('background-task:promote', { taskId }, backgroundTaskInfoSchema)
}

export function cancelBackgroundTask(taskId: string): Promise<BackgroundTaskInfo> {
  return requestControl('background-task:cancel', { taskId }, backgroundTaskInfoSchema)
}
