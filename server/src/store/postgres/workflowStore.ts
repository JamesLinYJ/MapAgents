// GeoForge Workflow、版本、调度和运行索引的 Postgres 所有权模块。
// 图定义快照与修订在事务内提交；运行历史正文仍由文件 conversation store 持有。

import { and, desc, eq, ne, or } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import {
  platformScheduledTasks,
  platformWorkflowDefinitions,
  platformWorkflowRuns,
  platformWorkflowVersions,
} from '../../db/schema.js'
import {
  scheduledTaskSchema,
  workflowApprovalRequestSchema,
  workflowDefinitionSchema,
  workflowNodeRunSchema,
  workflowRunRecordSchema,
  type ScheduledTask,
  type ScheduledTaskStatus,
  type WorkflowApprovalRequest,
  type WorkflowDefinition,
  type WorkflowNodeRun,
  type WorkflowRunRecord,
  type WorkflowStatus,
  type WorkflowTriggerKind,
  type WorkflowVersionRecord,
} from '../../workflows/schemas.js'

type WorkflowDefinitionRow = typeof platformWorkflowDefinitions.$inferSelect
type WorkflowVersionRow = typeof platformWorkflowVersions.$inferSelect
type ScheduledTaskRow = typeof platformScheduledTasks.$inferSelect
type WorkflowRunRow = typeof platformWorkflowRuns.$inferSelect

export interface CreateScheduledTaskInput {
  taskId: string
  targetKind: 'workflow'
  targetId: string
  workspaceId: string
  createdByUserId: string
  title: string
  prompt: string
  parameters: Record<string, unknown>
  cron: string
  timezone: string
  recurring: boolean
  enabled: boolean
  status: ScheduledTaskStatus
  nextFireAt: string | null
}

export interface UpdateScheduledTaskInput {
  targetKind?: 'workflow'
  targetId?: string
  title?: string
  prompt?: string
  parameters?: Record<string, unknown>
  cron?: string
  timezone?: string
  recurring?: boolean
  enabled?: boolean
  status?: ScheduledTaskStatus
  nextFireAt?: string | null
  lastFiredAt?: string | null
  lastRunId?: string | null
  queueJobId?: string | null
  failureCount?: number
  lastErrorMessage?: string | null
}

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

export class WorkflowStore {
  constructor(private readonly db: Database) {}

  async syncDefinitions(definitions: WorkflowDefinition[]): Promise<void> {
    await this.db.transaction(async tx => {
      for (const definition of definitions) {
        const now = new Date()
        await tx
          .insert(platformWorkflowDefinitions)
          .values(definitionInsert(definition, now))
          .onConflictDoUpdate({
            target: platformWorkflowDefinitions.workflowId,
            set: { ...definitionUpdate(definition, now), publishedRevision: definition.revision },
          })
        await tx
          .insert(platformWorkflowVersions)
          .values({
            workflowId: definition.workflowId,
            revision: definition.revision,
            lifecycle: 'published',
            definitionJson: definitionRecord(definition),
            createdByUserId: definition.createdByUserId,
            createdAt: now,
            publishedAt: now,
          })
          .onConflictDoUpdate({
            target: [platformWorkflowVersions.workflowId, platformWorkflowVersions.revision],
            set: {
              lifecycle: 'published',
              definitionJson: definitionRecord(definition),
              publishedAt: now,
            },
          })
      }
    })
  }

  async listDefinitions(workspaceId: string): Promise<WorkflowDefinition[]> {
    const rows = await this.db
      .select()
      .from(platformWorkflowDefinitions)
      .where(or(
        eq(platformWorkflowDefinitions.source, 'builtin'),
        eq(platformWorkflowDefinitions.workspaceId, workspaceId),
      ))
      .orderBy(platformWorkflowDefinitions.name)
    return rows.map(mapDefinitionRow)
  }

  async getDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
    const rows = await this.db
      .select()
      .from(platformWorkflowDefinitions)
      .where(eq(platformWorkflowDefinitions.workflowId, workflowId))
      .limit(1)
    return rows[0] ? mapDefinitionRow(rows[0]) : null
  }

  async getDefinitionVersion(workflowId: string, revision: number): Promise<WorkflowDefinition | null> {
    const rows = await this.db
      .select()
      .from(platformWorkflowVersions)
      .where(and(
        eq(platformWorkflowVersions.workflowId, workflowId),
        eq(platformWorkflowVersions.revision, revision),
      ))
      .limit(1)
    const row = rows[0]
    return row ? workflowDefinitionSchema.parse(row.definitionJson) : null
  }

  async getPublishedDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
    const rows = await this.db
      .select({
        publishedRevision: platformWorkflowDefinitions.publishedRevision,
        enabled: platformWorkflowDefinitions.enabled,
        lifecycle: platformWorkflowDefinitions.lifecycle,
      })
      .from(platformWorkflowDefinitions)
      .where(eq(platformWorkflowDefinitions.workflowId, workflowId))
      .limit(1)
    const head = rows[0]
    if (!head?.enabled || head.lifecycle === 'disabled') return null
    const revision = head.publishedRevision
    return revision ? this.getDefinitionVersion(workflowId, revision) : null
  }

  async listDefinitionVersions(workflowId: string): Promise<WorkflowVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(platformWorkflowVersions)
      .where(eq(platformWorkflowVersions.workflowId, workflowId))
      .orderBy(desc(platformWorkflowVersions.revision))
    return rows.map(mapVersionRow)
  }

  async createDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const now = new Date()
    await this.db.transaction(async tx => {
      await tx.insert(platformWorkflowDefinitions).values(definitionInsert(definition, now))
      await tx.insert(platformWorkflowVersions).values({
        workflowId: definition.workflowId,
        revision: definition.revision,
        lifecycle: definition.lifecycle === 'published' ? 'published' : 'draft',
        definitionJson: definitionRecord(definition),
        createdByUserId: definition.createdByUserId,
        createdAt: now,
        publishedAt: definition.lifecycle === 'published' ? now : null,
      })
    })
    const stored = await this.getDefinition(definition.workflowId)
    if (!stored) throw new Error('Workflow 创建后无法读取。')
    return stored
  }

  async saveDefinitionRevision(definition: WorkflowDefinition, expectedRevision: number): Promise<WorkflowDefinition> {
    if (definition.revision !== expectedRevision + 1) {
      throw new Error('Workflow 新修订号必须连续递增。')
    }
    const now = new Date()
    await this.db.transaction(async tx => {
      const updated = await tx
        .update(platformWorkflowDefinitions)
        .set(definitionUpdate(definition, now))
        .where(and(
          eq(platformWorkflowDefinitions.workflowId, definition.workflowId),
          eq(platformWorkflowDefinitions.revision, expectedRevision),
          eq(platformWorkflowDefinitions.source, 'workspace'),
        ))
        .returning({ workflowId: platformWorkflowDefinitions.workflowId })
      if (!updated[0]) throw new Error('Workflow 已被其他编辑更新，请刷新后再保存。')
      await tx.insert(platformWorkflowVersions).values({
        workflowId: definition.workflowId,
        revision: definition.revision,
        lifecycle: 'draft',
        definitionJson: definitionRecord(definition),
        createdByUserId: definition.createdByUserId,
        createdAt: now,
        publishedAt: null,
      })
    })
    const stored = await this.getDefinition(definition.workflowId)
    if (!stored) throw new Error('Workflow 保存后无法读取。')
    return stored
  }

  async publishDefinition(workflowId: string, revision: number): Promise<WorkflowDefinition> {
    const now = new Date()
    await this.db.transaction(async tx => {
      const versionRows = await tx
        .select()
        .from(platformWorkflowVersions)
        .where(and(
          eq(platformWorkflowVersions.workflowId, workflowId),
          eq(platformWorkflowVersions.revision, revision),
        ))
        .limit(1)
      const version = versionRows[0]
      if (!version) throw new Error(`Workflow '${workflowId}' 修订 ${revision} 不存在。`)
      const definition = workflowDefinitionSchema.parse(version.definitionJson)
      const publishedDefinition: WorkflowDefinition = {
        ...definition,
        revision,
        publishedRevision: revision,
        lifecycle: 'published',
        enabled: true,
        updatedAt: now.toISOString(),
      }
      await tx
        .update(platformWorkflowVersions)
        .set({ lifecycle: 'archived' })
        .where(and(
          eq(platformWorkflowVersions.workflowId, workflowId),
          eq(platformWorkflowVersions.lifecycle, 'published'),
        ))
      await tx
        .update(platformWorkflowVersions)
        .set({
          lifecycle: 'published',
          definitionJson: definitionRecord(publishedDefinition),
          publishedAt: now,
        })
        .where(and(
          eq(platformWorkflowVersions.workflowId, workflowId),
          eq(platformWorkflowVersions.revision, revision),
        ))
      await tx
        .update(platformWorkflowDefinitions)
        .set({ ...definitionUpdate(publishedDefinition, now), publishedRevision: revision })
        .where(and(
          eq(platformWorkflowDefinitions.workflowId, workflowId),
          eq(platformWorkflowDefinitions.source, 'workspace'),
        ))
    })
    const stored = await this.getDefinition(workflowId)
    if (!stored) throw new Error(`Workflow '${workflowId}' 发布后无法读取。`)
    return stored
  }

  async disableDefinition(workflowId: string): Promise<WorkflowDefinition> {
    const rows = await this.db
      .update(platformWorkflowDefinitions)
      .set({ lifecycle: 'disabled', enabled: false, updatedAt: new Date() })
      .where(and(
        eq(platformWorkflowDefinitions.workflowId, workflowId),
        eq(platformWorkflowDefinitions.source, 'workspace'),
      ))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`工作区 Workflow '${workflowId}' 不存在。`)
    return mapDefinitionRow(row)
  }

  async listScheduledTasks(workspaceId: string): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(and(
        eq(platformScheduledTasks.workspaceId, workspaceId),
        ne(platformScheduledTasks.status, 'deleted'),
      ))
      .orderBy(desc(platformScheduledTasks.updatedAt))
    return rows.map(mapScheduledTaskRow)
  }

  async listActiveScheduledTasks(): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(and(
        eq(platformScheduledTasks.enabled, true),
        eq(platformScheduledTasks.status, 'active'),
      ))
      .orderBy(platformScheduledTasks.nextFireAt)
    return rows.map(mapScheduledTaskRow)
  }

  async getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(eq(platformScheduledTasks.taskId, taskId))
      .limit(1)
    return rows[0] ? mapScheduledTaskRow(rows[0]) : null
  }

  async createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const now = new Date()
    const rows = await this.db
      .insert(platformScheduledTasks)
      .values({
        taskId: input.taskId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        title: input.title,
        prompt: input.prompt,
        parametersJson: input.parameters,
        cron: input.cron,
        timezone: input.timezone,
        recurring: input.recurring,
        enabled: input.enabled,
        status: input.status,
        nextFireAt: input.nextFireAt ? new Date(input.nextFireAt) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('定时任务创建后无法读取。')
    return mapScheduledTaskRow(row)
  }

  async updateScheduledTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const patch: Partial<typeof platformScheduledTasks.$inferInsert> = { updatedAt: new Date() }
    if (input.targetKind !== undefined) patch.targetKind = input.targetKind
    if (input.targetId !== undefined) patch.targetId = input.targetId
    if (input.title !== undefined) patch.title = input.title
    if (input.prompt !== undefined) patch.prompt = input.prompt
    if (input.parameters !== undefined) patch.parametersJson = input.parameters
    if (input.cron !== undefined) patch.cron = input.cron
    if (input.timezone !== undefined) patch.timezone = input.timezone
    if (input.recurring !== undefined) patch.recurring = input.recurring
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.status !== undefined) patch.status = input.status
    if (input.nextFireAt !== undefined) patch.nextFireAt = input.nextFireAt ? new Date(input.nextFireAt) : null
    if (input.lastFiredAt !== undefined) patch.lastFiredAt = input.lastFiredAt ? new Date(input.lastFiredAt) : null
    if (input.lastRunId !== undefined) patch.lastRunId = input.lastRunId
    if (input.queueJobId !== undefined) patch.queueJobId = input.queueJobId
    if (input.failureCount !== undefined) patch.failureCount = input.failureCount
    if (input.lastErrorMessage !== undefined) patch.lastErrorMessage = input.lastErrorMessage
    const rows = await this.db
      .update(platformScheduledTasks)
      .set(patch)
      .where(eq(platformScheduledTasks.taskId, taskId))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`定时任务 '${taskId}' 不存在。`)
    return mapScheduledTaskRow(row)
  }

  async markScheduledTaskDeleted(taskId: string): Promise<ScheduledTask> {
    return this.updateScheduledTask(taskId, { enabled: false, status: 'deleted', nextFireAt: null })
  }

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
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null
  }

  async updateWorkflowRun(workflowRunId: string, input: UpdateWorkflowRunInput): Promise<WorkflowRunRecord> {
    const patch: Partial<typeof platformWorkflowRuns.$inferInsert> = {}
    if (input.runId !== undefined) patch.runId = input.runId
    if (input.status !== undefined) patch.status = input.status
    if (input.currentStep !== undefined) patch.currentStep = input.currentStep
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage
    if (input.metadata !== undefined) patch.metadataJson = input.metadata
    if (input.nodeRuns !== undefined) patch.nodeRunsJson = records(input.nodeRuns)
    if (input.pendingApproval !== undefined) patch.pendingApprovalJson = input.pendingApproval ? record(input.pendingApproval) : null
    if (input.outputs !== undefined) patch.outputsJson = input.outputs
    if (input.completedAt !== undefined) patch.completedAt = input.completedAt ? new Date(input.completedAt) : null
    const rows = await this.db
      .update(platformWorkflowRuns)
      .set(patch)
      .where(eq(platformWorkflowRuns.workflowRunId, workflowRunId))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`Workflow 运行 '${workflowRunId}' 不存在。`)
    return mapWorkflowRunRow(row)
  }

  async listWorkflowRuns(workspaceId: string, scheduledTaskId?: string | null): Promise<WorkflowRunRecord[]> {
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

function definitionInsert(definition: WorkflowDefinition, now: Date): typeof platformWorkflowDefinitions.$inferInsert {
  return {
    workflowId: definition.workflowId,
    workspaceId: definition.workspaceId,
    createdByUserId: definition.createdByUserId,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    revision: definition.revision,
    publishedRevision: definition.lifecycle === 'published' ? definition.revision : null,
    source: definition.source,
    lifecycle: definition.lifecycle,
    enabled: definition.enabled,
    parametersSchemaJson: definition.parametersSchema,
    defaultParametersJson: definition.defaultParameters,
    requiredToolsJson: definition.requiredTools,
    requiresApproval: definition.requiresApproval,
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    definitionJson: definitionRecord(definition),
    createdAt: now,
    updatedAt: now,
  }
}

function definitionUpdate(definition: WorkflowDefinition, now: Date): Partial<typeof platformWorkflowDefinitions.$inferInsert> {
  return {
    workspaceId: definition.workspaceId,
    createdByUserId: definition.createdByUserId,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    revision: definition.revision,
    source: definition.source,
    lifecycle: definition.lifecycle,
    enabled: definition.enabled,
    parametersSchemaJson: definition.parametersSchema,
    defaultParametersJson: definition.defaultParameters,
    requiredToolsJson: definition.requiredTools,
    requiresApproval: definition.requiresApproval,
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    definitionJson: definitionRecord(definition),
    updatedAt: now,
  }
}

function mapDefinitionRow(row: WorkflowDefinitionRow): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.parse(row.definitionJson)
  if (parsed.workflowId !== row.workflowId || parsed.revision !== row.revision) {
    throw new Error(`Workflow '${row.workflowId}' 数据库元数据与 definition_json 不一致。`)
  }
  return workflowDefinitionSchema.parse({
    ...parsed,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    source: row.source,
    lifecycle: row.lifecycle,
    enabled: row.enabled,
    publishedRevision: row.publishedRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function mapVersionRow(row: WorkflowVersionRow): WorkflowVersionRecord {
  const lifecycle = row.lifecycle === 'draft' || row.lifecycle === 'published' || row.lifecycle === 'archived'
    ? row.lifecycle
    : fail(`Workflow 修订 lifecycle '${row.lifecycle}' 无效。`)
  return {
    workflowId: row.workflowId,
    revision: row.revision,
    lifecycle,
    definition: workflowDefinitionSchema.parse(row.definitionJson),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  }
}

function mapScheduledTaskRow(row: ScheduledTaskRow): ScheduledTask {
  return scheduledTaskSchema.parse({
    taskId: row.taskId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    prompt: row.prompt,
    parameters: row.parametersJson,
    cron: row.cron,
    timezone: row.timezone,
    recurring: row.recurring,
    enabled: row.enabled,
    status: row.status,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    queueJobId: row.queueJobId,
    failureCount: row.failureCount,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
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
    pendingApproval: row.pendingApprovalJson ? workflowApprovalRequestSchema.parse(row.pendingApprovalJson) : null,
    outputs: row.outputsJson,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  })
}

function definitionRecord(definition: WorkflowDefinition): Record<string, unknown> {
  return structuredClone(definition) as unknown as Record<string, unknown>
}

function record(value: object): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>
}

function records(values: readonly object[]): Array<Record<string, unknown>> {
  return values.map(value => record(value))
}

function fail(message: string): never {
  throw new Error(message)
}
