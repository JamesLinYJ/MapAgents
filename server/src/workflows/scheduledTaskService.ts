// GeoForge Workflow 启动、审批、取消、定时任务和进程内后台任务服务。
// 定义版本由 WorkflowDefinitionService 管理，持久队列由 pg-boss 管理。

import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { workflowRunsTotal } from '../observability/metrics.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { assertSupportedCronExpression, computeNextFireAt } from './cronSchedule.js'
import type { BackgroundTaskRegistry } from './backgroundTaskRegistry.js'
import type { JobQueueService } from './jobQueueService.js'
import type { ScheduledTask, WorkflowNodeRun, WorkflowRunRecord } from './schemas.js'
import type { WorkflowCompiler } from './workflowCompiler.js'
import type { WorkflowDefinitionService } from './workflowDefinitionService.js'
import {
  createWorkflowExecutionState,
  parseWorkflowExecutionState,
  withExecutionState,
} from './workflowExecutionState.js'

export interface WorkflowStartInput {
  workflowId: string
  prompt: string
  parameters?: Record<string, unknown> | undefined
}

export interface ScheduledTaskMutationInput {
  targetKind: 'workflow'
  targetId: string
  title?: string | null | undefined
  prompt: string
  parameters?: Record<string, unknown> | undefined
  cron: string
  timezone: string
  recurring?: boolean | undefined
  enabled?: boolean | undefined
}

export type ScheduledTaskPatchInput = {
  [Key in keyof ScheduledTaskMutationInput]?: ScheduledTaskMutationInput[Key] | undefined
}

interface NormalizedScheduledTaskMutation {
  targetKind: 'workflow'
  targetId: string
  title: string | null
  prompt: string
  parameters: Record<string, unknown>
  cron: string
  timezone: string
  recurring: boolean
  enabled: boolean
}

export interface ScheduledTaskSnapshot {
  tasks: ScheduledTask[]
  workflowRuns: WorkflowRunRecord[]
}

export class ScheduledTaskService {
  constructor(private readonly deps: {
    store: PostgresPlatformStore
    definitions: WorkflowDefinitionService
    compiler: WorkflowCompiler
    jobQueue: JobQueueService
    backgroundTasks: BackgroundTaskRegistry
    runTasks: RunTaskManager
    usageStats: UsageStatsService
    security: SecurityServices
  }) {}

  async reconcileSchedules(): Promise<void> {
    const tasks = await this.deps.store.listActiveScheduledTasks()
    for (const task of tasks) {
      try {
        if (isMissedOneShot(task)) {
          await this.deps.jobQueue.unscheduleTask(task.taskId, task.queueJobId)
          await this.deps.store.updateScheduledTask(task.taskId, {
            enabled: false,
            status: 'missed',
            queueJobId: null,
            lastErrorMessage: '一次性任务触发时间已错过，系统不会补执行。',
          })
          continue
        }
        await this.registerTaskSchedule(task)
      } catch (error) {
        logger.error({ error: errorLogPayload(error), taskId: task.taskId }, 'scheduled task reconciliation failed')
        await this.deps.store.updateScheduledTask(task.taskId, {
          status: 'failed',
          lastErrorMessage: '定时任务注册失败，请查看服务端日志。',
        })
      }
    }
  }

  async startWorkflow(auth: AuthContext, input: WorkflowStartInput): Promise<{ workflowRun: WorkflowRunRecord; jobId: string }> {
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, input.workflowId)
    await this.deps.security.authorization.enforce(auth, 'workflow', 'execute', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.workflowId,
    })
    const compiled = this.deps.compiler.compile(definition)
    if (compiled.definition.graph.nodes.some(node => node.type === 'agent')) {
      this.deps.usageStats.assertWorkspaceCanStartModelRun(auth)
    }
    const parameters = { ...definition.defaultParameters, ...(input.parameters ?? {}) }
    compiled.validateParameters(parameters)
    const executionState = createWorkflowExecutionState({
      definition: compiled.definition,
      prompt: input.prompt.trim(),
      parameters,
    })
    const workflowRunId = makeId('workflow_run')
    let workflowRun = await this.deps.store.createWorkflowRunRecord({
      workflowRunId,
      workflowId: definition.workflowId,
      workflowRevision: definition.revision,
      scheduledTaskId: null,
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      runId: null,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'manual',
      metadata: withExecutionState({}, executionState),
      nodeRuns: executionState.nodeRuns,
    })
    const dispatchId = makeId('workflow_dispatch')
    const jobId = await this.deps.jobQueue.enqueueWorkflowRun({
      workflowRunId,
      scheduledTaskId: null,
      workflowId: definition.workflowId,
      workspaceId: auth.defaultWorkspaceId,
      triggeredByUserId: auth.userId,
      triggerKind: 'manual',
      dispatchId,
      prompt: input.prompt.trim(),
      parameters,
    })
    workflowRun = await this.deps.store.updateWorkflowRunRecord(workflowRunId, {
      metadata: { ...workflowRun.metadata, queueJobId: jobId, dispatchId },
    })
    await this.deps.security.authorization.audit(auth, 'workflow', 'execute', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.workflowId,
    }, 'allowed', { operation: 'enqueue', workflowRunId, jobId, revision: definition.revision })
    return { workflowRun, jobId }
  }

  async cancelWorkflow(auth: AuthContext, workflowRunId: string): Promise<WorkflowRunRecord> {
    const workflowRun = await this.requireWorkflowRunInWorkspace(auth, workflowRunId)
    await this.deps.security.authorization.enforce(auth, 'workflow', 'execute', {
      workspaceId: workflowRun.workspaceId,
      resourceId: workflowRun.workflowId,
    })
    if (workflowRun.status === 'completed' || workflowRun.status === 'failed' || workflowRun.status === 'cancelled') {
      throw new Error('该 Workflow 运行已经结束，不能取消。')
    }
    const queueJobId = typeof workflowRun.metadata.queueJobId === 'string' ? workflowRun.metadata.queueJobId : null
    if (queueJobId) await this.deps.jobQueue.cancelWorkflowJob(queueJobId)
    const state = parseWorkflowExecutionState(workflowRun.metadata)
    if (state.currentAgentRunId) await this.deps.runTasks.cancel(state.currentAgentRunId)
    if (state.orchestrationRunId) {
      const run = this.deps.store.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.deps.store.completeRun(run.id, 'cancelled')
      }
    }
    const nodeRuns = state.nodeRuns.map(node => (
      node.status === 'pending' || node.status === 'running' || node.status === 'waiting_approval'
        ? { ...node, status: 'cancelled' as const, completedAt: nowUtc() }
        : node
    ))
    const cancelled = await this.deps.store.updateWorkflowRunRecord(workflowRunId, {
      status: 'cancelled',
      currentStep: null,
      pendingApproval: null,
      nodeRuns,
      metadata: withExecutionState(workflowRun.metadata, { ...state, nodeRuns, pendingApproval: null }),
      completedAt: nowUtc(),
    })
    const backgroundTaskId = `workflow:${workflowRunId}`
    if (this.deps.backgroundTasks.get(backgroundTaskId)?.status === 'running') {
      this.deps.backgroundTasks.cancel(backgroundTaskId)
    }
    workflowRunsTotal.inc({ trigger: workflowRun.triggerKind, status: 'cancelled' })
    await this.deps.security.authorization.audit(auth, 'workflow', 'execute', {
      workspaceId: workflowRun.workspaceId,
      resourceId: workflowRun.workflowId,
    }, 'allowed', { operation: 'cancel', workflowRunId })
    return cancelled
  }

  async respondApproval(
    auth: AuthContext,
    workflowRunId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<{ workflowRun: WorkflowRunRecord; jobId: string | null }> {
    const workflowRun = await this.requireWorkflowRunInWorkspace(auth, workflowRunId)
    await this.deps.security.authorization.enforce(auth, 'workflow', 'approve', {
      workspaceId: workflowRun.workspaceId,
      resourceId: workflowRun.workflowId,
    })
    if (workflowRun.status !== 'waiting_approval') throw new Error('该 Workflow 当前不在等待审批。')
    let state = parseWorkflowExecutionState(workflowRun.metadata)
    const pending = state.pendingApproval
    if (!pending || pending.approvalId !== approvalId || pending.status !== 'pending') {
      throw new Error('Workflow 审批请求不存在、已处理或与运行不匹配。')
    }
    const node = state.definitionSnapshot.graph.nodes.find(item => item.nodeId === pending.nodeId)
    if (!node) throw new Error(`审批节点 '${pending.nodeId}' 不存在。`)
    const resolved = {
      ...pending,
      status: decision,
      resolvedAt: nowUtc(),
      resolvedByUserId: auth.userId,
    }
    state = {
      ...state,
      pendingApproval: resolved,
      nodeRuns: patchNodeRun(state.nodeRuns, node.nodeId, { status: 'pending', errorMessage: null }),
      approvedNodeIds: decision === 'approved' && node.type === 'tool'
        ? [...new Set([...state.approvedNodeIds, node.nodeId])]
        : state.approvedNodeIds,
    }
    if (decision === 'rejected' && node.type === 'tool') {
      const hasErrorEdge = state.definitionSnapshot.graph.edges.some(edge => edge.sourceNodeId === node.nodeId && edge.sourcePort === 'error')
      if (!hasErrorEdge) {
        const rejectedNodeRuns = patchNodeRun(state.nodeRuns, node.nodeId, {
          status: 'failed',
          completedAt: nowUtc(),
          errorMessage: '用户拒绝执行工具。',
          output: { error: '用户拒绝执行工具。' },
        })
        const failed = await this.deps.store.updateWorkflowRunRecord(workflowRunId, {
          status: 'failed',
          currentStep: node.nodeId,
          errorMessage: '用户拒绝执行工具，且该节点没有错误分支。',
          nodeRuns: rejectedNodeRuns,
          pendingApproval: resolved,
          metadata: withExecutionState(workflowRun.metadata, { ...state, nodeRuns: rejectedNodeRuns }),
          completedAt: nowUtc(),
        })
        await this.deps.security.authorization.audit(auth, 'workflow', 'approve', {
          workspaceId: workflowRun.workspaceId,
          resourceId: workflowRun.workflowId,
        }, 'allowed', { workflowRunId, approvalId, decision, status: 'failed' })
        return { workflowRun: failed, jobId: null }
      }
      state = {
        ...state,
        pendingApproval: null,
        selectedPorts: { ...state.selectedPorts, [node.nodeId]: ['error'] },
        nodeOutputs: { ...state.nodeOutputs, [node.nodeId]: { error: '用户拒绝执行工具。' } },
        nodeRuns: patchNodeRun(state.nodeRuns, node.nodeId, {
          status: 'failed',
          completedAt: nowUtc(),
          errorMessage: '用户拒绝执行工具。',
          output: { error: '用户拒绝执行工具。' },
        }),
      }
    }
    const dispatchId = makeId('workflow_dispatch')
    let resumed = await this.deps.store.updateWorkflowRunRecord(workflowRunId, {
      status: 'queued',
      currentStep: node.nodeId,
      pendingApproval: state.pendingApproval,
      nodeRuns: state.nodeRuns,
      metadata: withExecutionState(workflowRun.metadata, state),
    })
    const jobId = await this.deps.jobQueue.enqueueWorkflowRun({
      workflowRunId,
      scheduledTaskId: workflowRun.scheduledTaskId,
      workflowId: workflowRun.workflowId,
      workspaceId: workflowRun.workspaceId,
      triggeredByUserId: workflowRun.createdByUserId,
      triggerKind: workflowRun.triggerKind,
      dispatchId,
      prompt: state.prompt,
      parameters: state.parameters,
    })
    resumed = await this.deps.store.updateWorkflowRunRecord(workflowRunId, {
      metadata: { ...resumed.metadata, queueJobId: jobId, dispatchId },
    })
    await this.deps.security.authorization.audit(auth, 'workflow', 'approve', {
      workspaceId: workflowRun.workspaceId,
      resourceId: workflowRun.workflowId,
    }, 'allowed', { workflowRunId, approvalId, decision })
    return { workflowRun: resumed, jobId }
  }

  async listScheduledTasks(auth: AuthContext): Promise<ScheduledTaskSnapshot> {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return {
      tasks: await this.deps.store.listScheduledTasks(auth.defaultWorkspaceId),
      workflowRuns: await this.deps.store.listWorkflowRuns(auth.defaultWorkspaceId),
    }
  }

  async createScheduledTask(auth: AuthContext, input: ScheduledTaskMutationInput): Promise<ScheduledTask> {
    const normalized = this.normalizeMutationInput(input)
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, normalized.targetId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.workflowId,
    })
    const compiled = this.deps.compiler.compile(definition)
    compiled.validateParameters({ ...definition.defaultParameters, ...normalized.parameters })
    assertSupportedCronExpression(normalized.cron)
    const taskId = makeId('scheduled_task')
    const nextFireAt = normalized.enabled
      ? computeNextFireAt({ cron: normalized.cron, timezone: normalized.timezone })
      : null
    let task = await this.deps.store.createScheduledTask({
      taskId,
      targetKind: normalized.targetKind,
      targetId: definition.workflowId,
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      title: normalized.title ?? definition.name,
      prompt: normalized.prompt,
      parameters: normalized.parameters,
      cron: normalized.cron,
      timezone: normalized.timezone,
      recurring: normalized.recurring,
      enabled: normalized.enabled,
      status: normalized.enabled ? 'active' : 'paused',
      nextFireAt,
    })
    if (task.enabled) task = await this.registerTaskSchedule(task)
    await this.deps.security.authorization.audit(auth, 'scheduled_task', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: task.taskId,
    }, 'allowed', { workflowId: definition.workflowId, cron: task.cron, timezone: task.timezone })
    return task
  }

  async updateScheduledTask(auth: AuthContext, taskId: string, input: ScheduledTaskPatchInput): Promise<ScheduledTask> {
    const existing = await this.requireTaskInWorkspace(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'update', {
      workspaceId: existing.workspaceId,
      resourceId: existing.taskId,
    })
    const merged = this.normalizeMutationInput({
      targetKind: input.targetKind ?? existing.targetKind,
      targetId: input.targetId ?? existing.targetId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      parameters: input.parameters ?? existing.parameters,
      cron: input.cron ?? existing.cron,
      timezone: input.timezone ?? existing.timezone,
      recurring: input.recurring ?? existing.recurring,
      enabled: input.enabled ?? existing.enabled,
    })
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, merged.targetId)
    const compiled = this.deps.compiler.compile(definition)
    compiled.validateParameters({ ...definition.defaultParameters, ...merged.parameters })
    assertSupportedCronExpression(merged.cron)
    const nextFireAt = merged.enabled ? computeNextFireAt({ cron: merged.cron, timezone: merged.timezone }) : null
    let task = await this.deps.store.updateScheduledTask(taskId, {
      targetKind: merged.targetKind,
      targetId: definition.workflowId,
      title: merged.title ?? definition.name,
      prompt: merged.prompt,
      parameters: merged.parameters,
      cron: merged.cron,
      timezone: merged.timezone,
      recurring: merged.recurring,
      enabled: merged.enabled,
      status: merged.enabled ? 'active' : 'paused',
      nextFireAt,
    })
    if (task.enabled) task = await this.registerTaskSchedule(task)
    else {
      await this.deps.jobQueue.unscheduleTask(task.taskId, existing.queueJobId)
      task = await this.deps.store.updateScheduledTask(task.taskId, { queueJobId: null })
    }
    return task
  }

  async deleteScheduledTask(auth: AuthContext, taskId: string): Promise<ScheduledTask> {
    const existing = await this.requireTaskInWorkspace(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'delete', {
      workspaceId: existing.workspaceId,
      resourceId: existing.taskId,
    })
    await this.deps.jobQueue.unscheduleTask(taskId, existing.queueJobId)
    const deleted = await this.deps.store.deleteScheduledTask(taskId)
    await this.deps.security.authorization.audit(auth, 'scheduled_task', 'delete', {
      workspaceId: existing.workspaceId,
      resourceId: taskId,
    }, 'allowed', { workflowId: existing.targetId })
    return deleted
  }

  async listBackgroundTasks(auth: AuthContext) {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return this.deps.backgroundTasks.list().filter(task => task.workspaceId === auth.defaultWorkspaceId)
  }

  async cancelBackgroundTask(auth: AuthContext, taskId: string) {
    const task = this.requireBackgroundTask(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'delete', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: taskId,
    })
    const workflowRunId = typeof task.metadata.workflowRunId === 'string'
      ? task.metadata.workflowRunId
      : null
    if (task.kind === 'workflow_run' && workflowRunId) {
      await this.cancelWorkflow(auth, workflowRunId)
      return this.deps.backgroundTasks.get(taskId) ?? task
    }
    return this.deps.backgroundTasks.cancel(taskId)
  }

  async promoteBackgroundTask(auth: AuthContext, taskId: string) {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'read', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: taskId,
    })
    this.requireBackgroundTask(auth, taskId)
    return this.deps.backgroundTasks.promote(taskId)
  }

  private requireBackgroundTask(auth: AuthContext, taskId: string) {
    const task = this.deps.backgroundTasks.get(taskId)
    if (!task || task.workspaceId !== auth.defaultWorkspaceId) throw new Error(`后台任务 '${taskId}' 不存在。`)
    return task
  }

  private async requireWorkflowRunInWorkspace(auth: AuthContext, workflowRunId: string): Promise<WorkflowRunRecord> {
    const workflowRun = await this.deps.store.getWorkflowRunRecord(workflowRunId)
    if (!workflowRun || workflowRun.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error(`Workflow 运行 '${workflowRunId}' 不存在。`)
    }
    return workflowRun
  }

  private async requireTaskInWorkspace(auth: AuthContext, taskId: string): Promise<ScheduledTask> {
    const task = await this.deps.store.getScheduledTask(taskId)
    if (!task || task.status === 'deleted' || task.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error(`定时任务 '${taskId}' 不存在。`)
    }
    return task
  }

  private async registerTaskSchedule(task: ScheduledTask): Promise<ScheduledTask> {
    if (!task.nextFireAt) throw new Error('启用定时任务前必须计算 nextFireAt。')
    if (task.queueJobId) await this.deps.jobQueue.unscheduleTask(task.taskId, task.queueJobId)
    const queueJobId = await this.deps.jobQueue.scheduleTask({
      taskId: task.taskId,
      cron: task.cron,
      timezone: task.timezone,
      recurring: task.recurring,
      nextFireAt: task.nextFireAt,
      payload: {
        workflowRunId: null,
        scheduledTaskId: task.taskId,
        workflowId: task.targetId,
        workspaceId: task.workspaceId,
        triggeredByUserId: task.createdByUserId,
        triggerKind: 'schedule',
        dispatchId: `schedule:${task.taskId}`,
        prompt: '',
        parameters: {},
      },
    })
    return this.deps.store.updateScheduledTask(task.taskId, { queueJobId })
  }

  private normalizeMutationInput(input: ScheduledTaskMutationInput): NormalizedScheduledTaskMutation {
    if (input.targetKind !== 'workflow') throw new Error('当前定时任务只支持 workflow 目标。')
    if (!input.targetId.trim()) throw new Error('定时任务 targetId 不能为空。')
    if (!input.prompt.trim()) throw new Error('定时任务 prompt 不能为空。')
    if (!input.timezone.trim()) throw new Error('定时任务 timezone 不能为空。')
    return {
      targetKind: 'workflow',
      targetId: input.targetId.trim(),
      title: input.title?.trim() || null,
      prompt: input.prompt.trim(),
      parameters: input.parameters ?? {},
      cron: input.cron.trim().replace(/\s+/gu, ' '),
      timezone: input.timezone.trim(),
      recurring: input.recurring ?? true,
      enabled: input.enabled ?? true,
    }
  }
}

function patchNodeRun(
  nodeRuns: WorkflowNodeRun[],
  nodeId: string,
  patch: Partial<WorkflowNodeRun>,
): WorkflowNodeRun[] {
  let found = false
  const next = nodeRuns.map(node => {
    if (node.nodeId !== nodeId) return node
    found = true
    return { ...node, ...patch }
  })
  if (!found) throw new Error(`Workflow 运行状态缺少节点 '${nodeId}'。`)
  return next
}

function isMissedOneShot(task: ScheduledTask): boolean {
  if (task.recurring || !task.nextFireAt) return false
  return Date.now() - new Date(task.nextFireAt).getTime() > 60_000
}
