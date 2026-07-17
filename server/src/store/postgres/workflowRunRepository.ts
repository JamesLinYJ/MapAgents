// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Workflow 运行仓储
//
//   文件:       workflowRunRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { and, desc, eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformWorkflowRuns } from '../../db/schema.js'
import {
  workflowApprovalRequestSchema,
  workflowNodeRunSchema,
  workflowRunRecordSchema,
  type WorkflowApprovalRequest,
  type WorkflowNodeRun,
  type WorkflowRunRecord,
  type WorkflowStatus,
  type WorkflowTriggerKind,
} from '../../workflows/schemas.js'

type WorkflowRunRow = typeof platformWorkflowRuns.$inferSelect

export interface CreateWorkflowRunInput {
  workflowRunId: string
  workflowId: string
  workflowRevision: number
  scheduledTaskId: string | null
  workspaceId: string
  createdByUserId: string
  runId: string | null
  status: WorkflowStatus
  currentStep: string | null
  triggerKind: WorkflowTriggerKind
  errorMessage?: string | null
  metadata?: Record<string, unknown>
  nodeRuns?: WorkflowNodeRun[]
  pendingApproval?: WorkflowApprovalRequest | null
  outputs?: Record<string, unknown>
}

export interface UpdateWorkflowRunInput {
  runId?: string | null
  status?: WorkflowStatus
  currentStep?: string | null
  errorMessage?: string | null
  metadata?: Record<string, unknown>
  nodeRuns?: WorkflowNodeRun[]
  pendingApproval?: WorkflowApprovalRequest | null
  outputs?: Record<string, unknown>
  completedAt?: string | null
}

/** Workflow 执行投影及节点状态的唯一写入边界。 */
export class WorkflowRunRepository {
  constructor(private readonly db: Database) {}

  async createWorkflowRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    const rows = await this.db
      .insert(platformWorkflowRuns)
      .values({
        workflowRunId: input.workflowRunId,
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        scheduledTaskId: input.scheduledTaskId,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        runId: input.runId,
        status: input.status,
        currentStep: input.currentStep,
        triggerKind: input.triggerKind,
        errorMessage: input.errorMessage ?? null,
        metadataJson: input.metadata ?? {},
        nodeRunsJson: records(input.nodeRuns ?? []),
        pendingApprovalJson: input.pendingApproval ? record(input.pendingApproval) : null,
        outputsJson: input.outputs ?? {},
        startedAt: new Date(),
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('Workflow 运行记录创建后无法读取。')
    return mapWorkflowRunRow(row)
  }

  async getWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord | null> {
    const rows = await this.db
      .select()
      .from(platformWorkflowRuns)
      .where(eq(platformWorkflowRuns.workflowRunId, workflowRunId))
      .limit(1)
    const row = rows[0]
    return row ? mapWorkflowRunRow(row) : null
  }

  async updateWorkflowRun(
    workflowRunId: string,
    input: UpdateWorkflowRunInput,
  ): Promise<WorkflowRunRecord> {
    const patch: Partial<typeof platformWorkflowRuns.$inferInsert> = {}
    if (input.runId !== undefined) patch.runId = input.runId
    if (input.status !== undefined) patch.status = input.status
    if (input.currentStep !== undefined) patch.currentStep = input.currentStep
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage
    if (input.metadata !== undefined) patch.metadataJson = input.metadata
    if (input.nodeRuns !== undefined) patch.nodeRunsJson = records(input.nodeRuns)
    if (input.pendingApproval !== undefined) {
      patch.pendingApprovalJson = input.pendingApproval ? record(input.pendingApproval) : null
    }
    if (input.outputs !== undefined) patch.outputsJson = input.outputs
    if (input.completedAt !== undefined) {
      patch.completedAt = input.completedAt ? new Date(input.completedAt) : null
    }
    const rows = await this.db
      .update(platformWorkflowRuns)
      .set(patch)
      .where(eq(platformWorkflowRuns.workflowRunId, workflowRunId))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`Workflow 运行 '${workflowRunId}' 不存在。`)
    return mapWorkflowRunRow(row)
  }

  async listWorkflowRuns(
    workspaceId: string,
    scheduledTaskId?: string | null,
  ): Promise<WorkflowRunRecord[]> {
    const conditions = [eq(platformWorkflowRuns.workspaceId, workspaceId)]
    if (scheduledTaskId) conditions.push(eq(platformWorkflowRuns.scheduledTaskId, scheduledTaskId))
    const rows = await this.db
      .select()
      .from(platformWorkflowRuns)
      .where(and(...conditions))
      .orderBy(desc(platformWorkflowRuns.startedAt))
      .limit(100)
    return rows.map(mapWorkflowRunRow)
  }
}

function mapWorkflowRunRow(row: WorkflowRunRow): WorkflowRunRecord {
  return workflowRunRecordSchema.parse({
    workflowRunId: row.workflowRunId,
    workflowId: row.workflowId,
    workflowRevision: row.workflowRevision,
    scheduledTaskId: row.scheduledTaskId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    runId: row.runId,
    status: row.status,
    currentStep: row.currentStep,
    triggerKind: row.triggerKind,
    errorMessage: row.errorMessage,
    metadata: row.metadataJson,
    nodeRuns: workflowNodeRunSchema.array().parse(row.nodeRunsJson),
    pendingApproval: row.pendingApprovalJson
      ? workflowApprovalRequestSchema.parse(row.pendingApprovalJson)
      : null,
    outputs: row.outputsJson,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  })
}

function record(value: object): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>
}

function records(values: readonly object[]): Array<Record<string, unknown>> {
  return values.map(value => record(value))
}
