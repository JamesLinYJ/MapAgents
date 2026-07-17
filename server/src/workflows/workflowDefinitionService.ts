// GeoForge Workflow 定义、修订和发布服务。
// 内置 JSON 与工作区草稿通过同一图编译器验证，发布后执行器固定消费修订快照。

import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { makeId, nowUtc } from '../utils/ids.js'
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowValidationResult,
  type WorkflowVersionRecord,
} from './schemas.js'
import type { WorkflowCompiler } from './workflowCompiler.js'
import { collectRequiredTools } from './workflowCompiler.js'
import type { WorkflowLoadDiagnostic, WorkflowRegistry } from './workflowRegistry.js'

export interface WorkflowListResult {
  definitions: WorkflowDefinition[]
  diagnostics: WorkflowLoadDiagnostic[]
  validation: Record<string, WorkflowValidationResult>
}

export interface WorkflowDraftInput {
  workflowId?: string | undefined
  name: string
  description: string
  version: string
  parametersSchema: Record<string, unknown>
  defaultParameters: Record<string, unknown>
  timeoutSeconds: number
  outputType: string
  graph: WorkflowDefinition['graph']
}

export class WorkflowDefinitionService {
  constructor(private readonly deps: {
    store: PlatformPersistenceFacade
    registry: WorkflowRegistry
    compiler: WorkflowCompiler
    security: SecurityServices
  }) {}

  async initialize(): Promise<void> {
    const definitions = this.deps.registry.list().map(definition => {
      const validation = this.deps.compiler.validate(definition)
      if (!validation.valid) {
        const messages = validation.issues
          .filter(issue => issue.severity === 'error')
          .map(issue => issue.message)
          .join('；')
        this.deps.registry.addDiagnostic({
          file: `${definition.workflowId}.json`,
          severity: 'error',
          message: `Workflow 图编译失败：${messages}`,
        })
        return { ...definition, enabled: false, lifecycle: 'disabled' as const }
      }
      return { ...definition, requiredTools: validation.requiredTools }
    })
    await this.deps.store.syncWorkflowDefinitions(definitions)
  }

  async list(auth: AuthContext): Promise<WorkflowListResult> {
    await this.deps.security.authorization.enforce(auth, 'workflow', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    const definitions = await this.deps.store.listWorkflowDefinitions(auth.defaultWorkspaceId)
    return {
      definitions,
      diagnostics: this.deps.registry.loadDiagnostics(),
      validation: Object.fromEntries(definitions.map(definition => [
        definition.workflowId,
        this.deps.compiler.validate(definition),
      ])),
    }
  }

  async validate(auth: AuthContext, input: WorkflowDraftInput): Promise<WorkflowValidationResult> {
    await this.deps.security.authorization.enforce(auth, 'workflow', 'create', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return this.deps.compiler.validate(this.toDraftDefinition(auth, input, 1))
  }

  async create(auth: AuthContext, input: WorkflowDraftInput): Promise<WorkflowDefinition> {
    await this.deps.security.authorization.enforce(auth, 'workflow', 'create', {
      workspaceId: auth.defaultWorkspaceId,
    })
    const definition = this.toDraftDefinition(auth, { ...input, workflowId: undefined }, 1)
    const validation = this.deps.compiler.validate(definition)
    assertValidation(validation)
    const saved = await this.deps.store.createWorkflowDefinition({
      ...definition,
      requiredTools: validation.requiredTools,
    })
    await this.deps.security.authorization.audit(auth, 'workflow', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: saved.workflowId,
    }, 'allowed', { revision: saved.revision })
    return saved
  }

  async saveDraft(
    auth: AuthContext,
    workflowId: string,
    expectedRevision: number,
    input: WorkflowDraftInput,
  ): Promise<WorkflowDefinition> {
    const existing = await this.requireWorkspaceDefinition(auth, workflowId, 'update')
    const definition = this.toDraftDefinition(auth, { ...input, workflowId }, expectedRevision + 1, existing.createdAt, existing.publishedRevision)
    const validation = this.deps.compiler.validate(definition)
    assertValidation(validation)
    const saved = await this.deps.store.saveWorkflowDefinitionRevision({
      ...definition,
      requiredTools: validation.requiredTools,
    }, expectedRevision)
    await this.deps.security.authorization.audit(auth, 'workflow', 'update', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: workflowId,
    }, 'allowed', { fromRevision: expectedRevision, toRevision: saved.revision })
    return saved
  }

  async publish(auth: AuthContext, workflowId: string, revision: number): Promise<WorkflowDefinition> {
    await this.requireWorkspaceDefinition(auth, workflowId, 'update')
    const version = await this.deps.store.getWorkflowDefinitionVersion(workflowId, revision)
    if (!version) throw new Error(`Workflow '${workflowId}' 修订 ${revision} 不存在。`)
    const compiled = this.deps.compiler.compile(version)
    const published = await this.deps.store.publishWorkflowDefinition(workflowId, revision)
    await this.deps.security.authorization.audit(auth, 'workflow', 'update', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: workflowId,
    }, 'allowed', { operation: 'publish', revision, requiredTools: compiled.definition.requiredTools })
    return published
  }

  async disable(auth: AuthContext, workflowId: string): Promise<WorkflowDefinition> {
    await this.requireWorkspaceDefinition(auth, workflowId, 'delete')
    const disabled = await this.deps.store.disableWorkflowDefinition(workflowId)
    await this.deps.security.authorization.audit(auth, 'workflow', 'delete', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: workflowId,
    }, 'allowed', { operation: 'disable' })
    return disabled
  }

  async history(auth: AuthContext, workflowId: string): Promise<WorkflowVersionRecord[]> {
    const definition = await this.requireVisibleDefinition(auth, workflowId, 'read')
    return this.deps.store.listWorkflowDefinitionVersions(definition.workflowId)
  }

  async requirePublished(workspaceId: string, workflowId: string, revision?: number): Promise<WorkflowDefinition> {
    const definition = revision
      ? await this.deps.store.getWorkflowDefinitionVersion(workflowId, revision)
      : await this.deps.store.getPublishedWorkflowDefinition(workflowId)
    if (!definition) throw new Error(`Workflow '${workflowId}' 不存在。`)
    if (definition.source === 'workspace' && definition.workspaceId !== workspaceId) {
      throw new Error('无权访问该 Workflow。')
    }
    if (!definition.enabled || definition.lifecycle !== 'published') {
      throw new Error(`Workflow '${definition.name}' 未发布或已禁用。`)
    }
    return definition
  }

  private async requireVisibleDefinition(
    auth: AuthContext,
    workflowId: string,
    action: 'read' | 'update' | 'delete',
  ): Promise<WorkflowDefinition> {
    const definition = await this.deps.store.getWorkflowDefinition(workflowId)
    if (!definition) throw new Error(`Workflow '${workflowId}' 不存在。`)
    if (definition.source === 'workspace' && definition.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error('无权访问该 Workflow。')
    }
    await this.deps.security.authorization.enforce(auth, 'workflow', action, {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: workflowId,
    })
    return definition
  }

  private async requireWorkspaceDefinition(
    auth: AuthContext,
    workflowId: string,
    action: 'update' | 'delete',
  ): Promise<WorkflowDefinition> {
    const definition = await this.requireVisibleDefinition(auth, workflowId, action)
    if (definition.source !== 'workspace') throw new Error('内置 Workflow 只读，不能直接修改。请复制为工作区 Workflow。')
    return definition
  }

  private toDraftDefinition(
    auth: AuthContext,
    input: WorkflowDraftInput,
    revision: number,
    createdAt: string | null = nowUtc(),
    publishedRevision: number | null = null,
  ): WorkflowDefinition {
    return workflowDefinitionSchema.parse({
      workflowId: input.workflowId?.trim() || makeId('workflow'),
      name: input.name.trim(),
      description: input.description.trim(),
      version: input.version.trim(),
      revision,
      publishedRevision,
      source: 'workspace',
      lifecycle: 'draft',
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      enabled: true,
      parametersSchema: input.parametersSchema,
      defaultParameters: input.defaultParameters,
      requiredTools: collectRequiredTools(input.graph),
      requiresApproval: input.graph.nodes.some(node => node.type === 'approval'),
      timeoutSeconds: input.timeoutSeconds,
      outputType: input.outputType,
      graph: input.graph,
      createdAt,
      updatedAt: nowUtc(),
    })
  }
}

function assertValidation(validation: WorkflowValidationResult): void {
  if (validation.valid) return
  const detail = validation.issues
    .filter(issue => issue.severity === 'error')
    .map(issue => issue.message)
    .join('；')
  throw new Error(`Workflow 图校验失败：${detail}`)
}
