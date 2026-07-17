// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Workflow 定义版本仓储
//
//   文件:       workflowDefinitionRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { and, desc, eq, or } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformWorkflowDefinitions, platformWorkflowVersions } from '../../db/schema.js'
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowVersionRecord,
} from '../../workflows/schemas.js'

type WorkflowDefinitionRow = typeof platformWorkflowDefinitions.$inferSelect
type WorkflowVersionRow = typeof platformWorkflowVersions.$inferSelect

/** Workflow 定义头与不可变修订快照的唯一写入边界。 */
export class WorkflowDefinitionRepository {
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
    const row = rows[0]
    return row ? mapDefinitionRow(row) : null
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
    return head.publishedRevision
      ? this.getDefinitionVersion(workflowId, head.publishedRevision)
      : null
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

  async saveDefinitionRevision(
    definition: WorkflowDefinition,
    expectedRevision: number,
  ): Promise<WorkflowDefinition> {
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
}

function definitionInsert(
  definition: WorkflowDefinition,
  now: Date,
): typeof platformWorkflowDefinitions.$inferInsert {
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

function definitionUpdate(
  definition: WorkflowDefinition,
  now: Date,
): Partial<typeof platformWorkflowDefinitions.$inferInsert> {
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
  if (row.lifecycle !== 'draft' && row.lifecycle !== 'published' && row.lifecycle !== 'archived') {
    throw new Error(`Workflow 修订 lifecycle '${row.lifecycle}' 无效。`)
  }
  return {
    workflowId: row.workflowId,
    revision: row.revision,
    lifecycle: row.lifecycle,
    definition: workflowDefinitionSchema.parse(row.definitionJson),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  }
}

function definitionRecord(definition: WorkflowDefinition): Record<string, unknown> {
  return structuredClone(definition) as unknown as Record<string, unknown>
}
