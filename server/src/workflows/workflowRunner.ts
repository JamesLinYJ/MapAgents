// GeoForge Workflow DAG 执行器。
// 每次运行固定消费 definition revision 快照；节点状态、分支选择和审批 checkpoint 持久化后才继续。

import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { resolveRuntimeConfig } from '../ws/runtimeConfig.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { workflowNodeDurationMs, workflowNodeExecutionsTotal, workflowRunsTotal } from '../observability/metrics.js'
import { executePersistedTool } from '../tools/persistentToolExecutor.js'
import { computeNextFireAt } from './cronSchedule.js'
import type { WorkflowJobPayload } from './jobQueueService.js'
import { workflowJobPayloadSchema } from './jobQueueService.js'
import {
  evaluateWorkflowCondition,
  renderWorkflowPrompt,
  resolveWorkflowArguments,
  resolveWorkflowBinding,
  type WorkflowBindingContext,
} from './workflowBindings.js'
import type { CompiledWorkflow, WorkflowCompiler } from './workflowCompiler.js'
import type { WorkflowDefinitionService } from './workflowDefinitionService.js'
import type { BackgroundTaskRegistry } from './backgroundTaskRegistry.js'
import {
  createWorkflowExecutionState,
  parseWorkflowExecutionState,
  withExecutionState,
  type WorkflowExecutionState,
} from './workflowExecutionState.js'
import type { WorkflowNode, WorkflowNodeRun, WorkflowRunRecord } from './schemas.js'

export interface WorkflowRunnerOptions {
  store: PlatformPersistenceFacade
  definitions: WorkflowDefinitionService
  compiler: WorkflowCompiler
  toolRegistry: ToolRegistry
  runTasks: RunTaskManager
  modelRegistry: ModelAdapterRegistry
  security: SecurityServices
  usageStats: UsageStatsService
  backgroundTasks: BackgroundTaskRegistry
  defaultRuntimeConfig?: AgentRuntimeConfig
  unscheduleTask?: (taskId: string) => Promise<void>
}

export class WorkflowRunner {
  constructor(private readonly options: WorkflowRunnerOptions) {}

  async executeQueuedJob(rawPayload: WorkflowJobPayload, queueJobId: string): Promise<void> {
    const payload = workflowJobPayloadSchema.parse(rawPayload)
    if (payload.triggerKind === 'schedule') await this.executeScheduled(payload, queueJobId)
    else await this.executeManual(payload)
  }

  private async executeManual(payload: WorkflowJobPayload): Promise<void> {
    const workflowRunId = requireWorkflowRunId(payload)
    const workflowRun = await this.requireWorkflowRun(workflowRunId)
    if (workflowRun.status === 'completed' || workflowRun.status === 'cancelled' || workflowRun.status === 'waiting_approval') return
    if (workflowRun.status === 'failed') throw new Error('Workflow 运行已经失败，队列不会隐式重置节点状态。')
    let auth: AuthContext | null = null
    try {
      auth = await this.options.security.auth.buildServiceAuthContext(payload.triggeredByUserId, payload.workspaceId)
      await this.options.security.authorization.enforce(auth, 'workflow', 'execute', {
        workspaceId: payload.workspaceId,
        resourceId: payload.workflowId,
      })
      await this.executeTracked(workflowRun, auth)
    } catch (error) {
      await this.failWorkflowRun(workflowRunId, error)
      await this.options.security.authorization.audit(auth, 'workflow', 'execute', {
        workspaceId: payload.workspaceId,
        resourceId: payload.workflowId,
      }, 'error', { workflowRunId, error: formatWorkflowError(error) })
      logger.warn({ error: errorLogPayload(error), workflowRunId, workflowId: payload.workflowId }, 'manual workflow failed')
      throw error
    }
  }

  private async executeScheduled(payload: WorkflowJobPayload, queueJobId: string): Promise<void> {
    if (!payload.scheduledTaskId) throw new Error('定时任务 job 缺少 scheduledTaskId。')
    const task = await this.options.store.getScheduledTask(payload.scheduledTaskId)
    if (!task || task.status === 'deleted') throw new Error(`定时任务 '${payload.scheduledTaskId}' 不存在或已删除。`)
    if (!task.enabled || task.status !== 'active') throw new Error('定时任务当前未启用。')
    if (!task.recurring && task.nextFireAt && Date.now() - new Date(task.nextFireAt).getTime() > 60_000) {
      await this.options.unscheduleTask?.(task.taskId)
      await this.options.store.updateScheduledTask(task.taskId, {
        enabled: false,
        status: 'missed',
        queueJobId: null,
        lastErrorMessage: '一次性任务触发时间已错过，系统不会补执行。',
      })
      return
    }
    const definition = await this.options.definitions.requirePublished(task.workspaceId, task.targetId)
    const compiled = this.options.compiler.compile(definition)
    const parameters = { ...definition.defaultParameters, ...task.parameters }
    compiled.validateParameters(parameters)
    const workflowRunId = `workflow_run_${queueJobId}`
    const existing = await this.options.store.getWorkflowRunRecord(workflowRunId)
    if (existing?.status === 'completed' || existing?.status === 'cancelled' || existing?.status === 'waiting_approval') return
    if (existing?.status === 'failed') throw new Error('该次定时 Workflow 运行已经失败，不会创建重复运行。')
    const executionState = createWorkflowExecutionState({ definition, prompt: task.prompt, parameters })
    const workflowRun = existing ?? await this.options.store.createWorkflowRunRecord({
      workflowRunId,
      workflowId: definition.workflowId,
      workflowRevision: definition.revision,
      scheduledTaskId: task.taskId,
      workspaceId: task.workspaceId,
      createdByUserId: task.createdByUserId,
      runId: null,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'schedule',
      metadata: withExecutionState({ queueJobId }, executionState),
      nodeRuns: executionState.nodeRuns,
    })
    let auth: AuthContext | null = null
    try {
      auth = await this.options.security.auth.buildServiceAuthContext(task.createdByUserId, task.workspaceId)
      await this.options.security.authorization.enforce(auth, 'workflow', 'execute', {
        workspaceId: task.workspaceId,
        resourceId: task.targetId,
      })
      await this.executeTracked(workflowRun, auth)
      await this.updateTaskAfterFire(task.taskId, task.recurring, task.cron, task.timezone, workflowRunId, null)
    } catch (error) {
      await this.failWorkflowRun(workflowRunId, error)
      await this.options.security.authorization.audit(auth, 'workflow', 'execute', {
        workspaceId: task.workspaceId,
        resourceId: task.targetId,
      }, 'error', { workflowRunId, scheduledTaskId: task.taskId, error: formatWorkflowError(error) })
      await this.updateTaskAfterFire(task.taskId, task.recurring, task.cron, task.timezone, workflowRunId, error)
      logger.warn({ error: errorLogPayload(error), taskId: task.taskId, workflowRunId }, 'scheduled workflow failed')
      throw error
    }
  }

  private async executeWorkflowRun(initialRecord: WorkflowRunRecord, auth: AuthContext): Promise<void> {
    let record = initialRecord
    let state = parseWorkflowExecutionState(record.metadata)
    const compiled = this.options.compiler.compile(state.definitionSnapshot)
    compiled.validateParameters(state.parameters)
    state = await this.ensureOrchestrationRun(record, state, auth)
    record = await this.persistState(record, state, 'running')

    while (true) {
      const latest = await this.requireWorkflowRun(record.workflowRunId)
      if (latest.status === 'cancelled') {
        await this.cancelOrchestrationRun(state)
        return
      }
      state = parseWorkflowExecutionState(latest.metadata)
      if (state.pendingApproval?.status === 'pending') return

      const next = findNextNode(compiled, state)
      if (!next) {
        const incomplete = state.nodeRuns.filter(node => !isTerminal(node.status))
        if (incomplete.length) throw new Error(`Workflow 无法继续，仍有未决节点：${incomplete.map(node => node.label).join('、')}`)
        await this.completeWorkflowRun(latest, state, auth)
        return
      }
      if (next.action === 'skip') {
        state = updateNodeRun(state, next.node.nodeId, {
          status: 'skipped',
          completedAt: nowUtc(),
          errorMessage: null,
        })
        record = await this.persistState(latest, state, 'running')
        continue
      }

      const nodeStartedAt = performance.now()
      let outcome: Awaited<ReturnType<WorkflowRunner['executeNode']>>
      try {
        outcome = await this.executeNode(compiled, next.node, latest, state, auth)
        workflowNodeExecutionsTotal.inc({ node_type: next.node.type, status: outcome.paused ? 'waiting_approval' : 'completed' })
      } catch (error) {
        workflowNodeExecutionsTotal.inc({ node_type: next.node.type, status: 'failed' })
        throw error
      } finally {
        workflowNodeDurationMs.observe({ node_type: next.node.type }, performance.now() - nodeStartedAt)
      }
      state = outcome.state
      record = await this.persistState(latest, state, outcome.paused ? 'waiting_approval' : 'running')
      if (outcome.paused) {
        if (state.orchestrationRunId) await this.options.store.updateRunStatus(state.orchestrationRunId, 'waiting_approval')
        return
      }
    }
  }

  private executeTracked(record: WorkflowRunRecord, auth: AuthContext): Promise<void> {
    return this.options.backgroundTasks.start({
      taskId: `workflow:${record.workflowRunId}`,
      label: `工作流：${record.workflowId}`,
      kind: 'workflow_run',
      workspaceId: record.workspaceId,
      userId: record.createdByUserId,
      metadata: { workflowRunId: record.workflowRunId, workflowId: record.workflowId },
      run: () => this.executeWorkflowRun(record, auth),
    })
  }

  private async executeNode(
    compiled: CompiledWorkflow,
    node: WorkflowNode,
    record: WorkflowRunRecord,
    state: WorkflowExecutionState,
    auth: AuthContext,
  ): Promise<{ state: WorkflowExecutionState; paused: boolean }> {
    let nextState = updateNodeRun(state, node.nodeId, {
      status: 'running',
      startedAt: nowUtc(),
      attempt: nodeRun(state, node.nodeId).attempt + 1,
      errorMessage: null,
    })
    await this.persistState(record, nextState, 'running')
    const context = bindingContext(nextState)
    try {
      if (node.type === 'trigger') {
        return completed(nextState, node, { prompt: state.prompt, parameters: state.parameters }, ['default'])
      }
      if (node.type === 'condition') {
        const left = resolveWorkflowBinding(node.config.left, context)
        const right = node.config.right ? resolveWorkflowBinding(node.config.right, context) : null
        const result = evaluateWorkflowCondition(left, node.config.operator, right)
        return completed(nextState, node, { result, left, right }, [result ? 'true' : 'false'])
      }
      if (node.type === 'approval') {
        const existing = nextState.pendingApproval
        if (existing?.nodeId === node.nodeId && existing.status !== 'pending') {
          return completed(nextState, node, { decision: existing.status }, [existing.status === 'approved' ? 'approved' : 'rejected'])
        }
        const approval = {
          approvalId: makeId('workflow_approval'),
          nodeId: node.nodeId,
          title: node.config.title,
          question: node.config.question,
          description: node.config.description,
          status: 'pending' as const,
          createdAt: nowUtc(),
          resolvedAt: null,
          resolvedByUserId: null,
        }
        nextState = updateNodeRun({ ...nextState, pendingApproval: approval }, node.nodeId, { status: 'waiting_approval' })
        return { state: nextState, paused: true }
      }
      if (node.type === 'tool') {
        const tool = this.options.toolRegistry.get(node.config.toolName)
        if (!tool) throw new Error(`工具“${node.label}”未注册。`)
        await this.options.security.authorization.enforce(auth, 'tool', 'execute', {
          workspaceId: record.workspaceId,
          resourceId: node.config.toolName,
        })
        const needsApproval = node.config.approvalMode === 'always' || tool.isDestructive || tool.requiresApproval === true
        if (needsApproval && !nextState.approvedNodeIds.includes(node.nodeId)) {
          const approval = {
            approvalId: makeId('workflow_approval'),
            nodeId: node.nodeId,
            title: `批准执行：${tool.label}`,
            question: `是否允许 Workflow 执行工具“${tool.label}”？`,
            description: tool.isDestructive ? '该工具包含破坏性操作。' : '该工具声明需要人工批准。',
            status: 'pending' as const,
            createdAt: nowUtc(),
            resolvedAt: null,
            resolvedByUserId: null,
          }
          nextState = updateNodeRun({ ...nextState, pendingApproval: approval }, node.nodeId, { status: 'waiting_approval' })
          return { state: nextState, paused: true }
        }
        const args = resolveWorkflowArguments(node.config.arguments, context)
        const result = await retry(node.config.retry, async () => executePersistedTool({
          runId: requireOrchestrationRunId(nextState),
          toolName: node.config.toolName,
          args,
          auth,
        }, {
          store: this.options.store,
          registry: this.options.toolRegistry,
          modelRegistry: this.options.modelRegistry,
          defaultRuntimeConfig: this.options.defaultRuntimeConfig,
        }))
        return completed(nextState, node, {
          message: result.message,
          payload: result.payload,
          valueRefs: result.valueRefs ?? [],
          artifacts: result.artifacts ?? [],
          resultId: result.resultId,
          source: result.source,
        }, successPorts(compiled, node.nodeId))
      }
      if (node.type === 'agent') {
        this.options.usageStats.assertWorkspaceCanStartModelRun(auth)
        const prompt = renderWorkflowPrompt(node.config.promptTemplate, context)
        const response = await retry(node.config.retry, () => this.executeAgentNode(record, nextState, node.nodeId, prompt, node.config, auth))
        nextState = { ...nextState, currentAgentRunId: null }
        return completed(nextState, node, response, successPorts(compiled, node.nodeId))
      }
      const outputs = Object.fromEntries(Object.entries(node.config.outputs).map(([name, binding]) => [
        name,
        resolveWorkflowBinding(binding, context),
      ]))
      return completed(nextState, node, outputs, [])
    } catch (error) {
      const message = formatWorkflowError(error)
      const errorEdges = compiled.outgoingEdges.get(node.nodeId)?.filter(edge => edge.sourcePort === 'error') ?? []
      nextState = updateNodeRun(nextState, node.nodeId, {
        status: 'failed',
        completedAt: nowUtc(),
        errorMessage: message,
        output: { error: message },
      })
      nextState = {
        ...nextState,
        nodeOutputs: { ...nextState.nodeOutputs, [node.nodeId]: { error: message } },
        selectedPorts: { ...nextState.selectedPorts, [node.nodeId]: errorEdges.length ? ['error'] : [] },
        currentAgentRunId: null,
      }
      if (errorEdges.length) return { state: nextState, paused: false }
      await this.options.store.updateWorkflowRunRecord(record.workflowRunId, {
        status: 'failed',
        currentStep: node.nodeId,
        errorMessage: message,
        nodeRuns: nextState.nodeRuns,
        metadata: withExecutionState(record.metadata, nextState),
        completedAt: nowUtc(),
      })
      throw error
    }
  }

  private async executeAgentNode(
    record: WorkflowRunRecord,
    state: WorkflowExecutionState,
    nodeId: string,
    prompt: string,
    config: Extract<WorkflowNode, { type: 'agent' }>['config'],
    auth: AuthContext,
  ): Promise<Record<string, unknown>> {
    const sessionId = requireString(state.sessionId, 'Workflow sessionId')
    const threadId = requireString(state.threadId, 'Workflow threadId')
    const runtimeConfig = await resolveRuntimeConfig(this.options.store, this.options.defaultRuntimeConfig)
    const provider = this.options.modelRegistry.defaultProvider
    if (!provider) throw new Error('必须配置默认模型 provider，Workflow Agent 节点才能执行。')
    const run = await this.options.store.createRun(sessionId, prompt, {
      threadId,
      modelProvider: provider,
      modelName: null,
      runtimeConfigSnapshot: runtimeConfig,
    })
    const nextState = { ...state, currentAgentRunId: run.id }
    await this.persistState(record, nextState, 'running')
    const completedRun = await this.options.runTasks.start({
      runId: run.id,
      threadId,
      sessionId,
      query: prompt,
      provider,
      modelName: run.modelName,
      runtimeConfig,
      executionMode: config.executionMode,
      reasoning: config.reasoning,
      auth,
    })
    if (completedRun.status !== 'completed') {
      throw new Error(completedRun.state.errors.at(-1) ?? `Agent 节点 '${nodeId}' 状态为 ${completedRun.status}。`)
    }
    const response = await latestAssistantResponse(this.options.store, threadId, completedRun.id)
    return { runId: completedRun.id, threadId, response }
  }

  private async ensureOrchestrationRun(
    record: WorkflowRunRecord,
    state: WorkflowExecutionState,
    auth: AuthContext,
  ): Promise<WorkflowExecutionState> {
    if (state.sessionId && state.threadId && state.orchestrationRunId) {
      if (this.options.store.getRun(state.orchestrationRunId).status === 'waiting_approval') {
        await this.options.store.updateRunStatus(state.orchestrationRunId, 'running')
      }
      return state
    }
    const session = await this.options.store.getOrCreateUserDefaultSession({
      workspaceId: record.workspaceId,
      userId: record.createdByUserId,
    })
    const thread = await this.options.store.createThread(session.id, state.definitionSnapshot.name)
    const config = await resolveRuntimeConfig(this.options.store, this.options.defaultRuntimeConfig)
    const run = await this.options.store.createRun(session.id, state.prompt || state.definitionSnapshot.name, {
      threadId: thread.id,
      modelProvider: this.options.modelRegistry.defaultProvider || null,
      modelName: null,
      runtimeConfigSnapshot: config,
    })
    await this.options.store.updateRunStatus(run.id, 'running')
    this.options.backgroundTasks.updateInfo(`workflow:${record.workflowRunId}`, {
      runId: run.id,
      metadata: {
        workflowRunId: record.workflowRunId,
        workflowId: record.workflowId,
        sessionId: session.id,
        threadId: thread.id,
      },
    })
    await this.options.security.authorization.audit(auth, 'workflow', 'execute', {
      workspaceId: record.workspaceId,
      resourceId: record.workflowId,
    }, 'allowed', { workflowRunId: record.workflowRunId, revision: record.workflowRevision, runId: run.id })
    return {
      ...state,
      sessionId: session.id,
      threadId: thread.id,
      orchestrationRunId: run.id,
    }
  }

  private async persistState(
    record: WorkflowRunRecord,
    state: WorkflowExecutionState,
    status: WorkflowRunRecord['status'],
  ): Promise<WorkflowRunRecord> {
    const current = state.nodeRuns.find(node => node.status === 'running' || node.status === 'waiting_approval')
    return this.options.store.updateWorkflowRunRecord(record.workflowRunId, {
      runId: state.orchestrationRunId,
      status,
      currentStep: current?.nodeId ?? null,
      errorMessage: null,
      metadata: withExecutionState(record.metadata, state),
      nodeRuns: state.nodeRuns,
      pendingApproval: state.pendingApproval,
    })
  }

  private async completeWorkflowRun(record: WorkflowRunRecord, state: WorkflowExecutionState, auth: AuthContext): Promise<void> {
    const outputNodes = state.definitionSnapshot.graph.nodes.filter(node => node.type === 'output')
    const outputs = Object.assign({}, ...outputNodes.map(node => state.nodeOutputs[node.nodeId] ?? {})) as Record<string, unknown>
    if (state.orchestrationRunId) await this.options.store.completeRun(state.orchestrationRunId, 'completed')
    await this.options.store.updateWorkflowRunRecord(record.workflowRunId, {
      status: 'completed',
      currentStep: null,
      outputs,
      pendingApproval: null,
      metadata: withExecutionState(record.metadata, { ...state, pendingApproval: null }),
      nodeRuns: state.nodeRuns,
      completedAt: nowUtc(),
    })
    await this.options.security.authorization.audit(auth, 'workflow', 'execute', {
      workspaceId: record.workspaceId,
      resourceId: record.workflowId,
    }, 'allowed', { workflowRunId: record.workflowRunId, revision: record.workflowRevision, status: 'completed' })
    workflowRunsTotal.inc({ trigger: record.triggerKind, status: 'completed' })
  }

  private async failWorkflowRun(workflowRunId: string, error: unknown): Promise<void> {
    const record = await this.options.store.getWorkflowRunRecord(workflowRunId)
    if (!record || record.status === 'cancelled' || record.status === 'completed') return
    const message = formatWorkflowError(error)
    const state = parseWorkflowExecutionState(record.metadata)
    if (state.orchestrationRunId) {
      const run = this.options.store.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.options.store.updateRunState(run.id, { errors: [...run.state.errors, message] })
        await this.options.store.completeRun(run.id, 'failed')
      }
    }
    await this.options.store.updateWorkflowRunRecord(workflowRunId, {
      status: 'failed',
      errorMessage: message,
      completedAt: nowUtc(),
      nodeRuns: state.nodeRuns,
      metadata: withExecutionState(record.metadata, state),
    })
    workflowRunsTotal.inc({ trigger: record.triggerKind, status: 'failed' })
  }

  private async cancelOrchestrationRun(state: WorkflowExecutionState): Promise<void> {
    if (state.currentAgentRunId) await this.options.runTasks.cancel(state.currentAgentRunId)
    if (state.orchestrationRunId) {
      const run = this.options.store.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) await this.options.store.completeRun(run.id, 'cancelled')
    }
  }

  private async requireWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord> {
    const run = await this.options.store.getWorkflowRunRecord(workflowRunId)
    if (!run) throw new Error(`Workflow 运行 '${workflowRunId}' 不存在。`)
    return run
  }

  private async updateTaskAfterFire(
    taskId: string,
    recurring: boolean,
    cron: string,
    timezone: string,
    workflowRunId: string,
    error: unknown,
  ): Promise<void> {
    const task = await this.options.store.getScheduledTask(taskId)
    const failureCount = (task?.failureCount ?? 0) + (error ? 1 : 0)
    if (!recurring) {
      await this.options.unscheduleTask?.(taskId)
      await this.options.store.updateScheduledTask(taskId, {
        enabled: false,
        status: error ? 'failed' : 'paused',
        lastFiredAt: nowUtc(),
        nextFireAt: null,
        lastRunId: workflowRunId,
        queueJobId: null,
        failureCount,
        lastErrorMessage: error ? formatWorkflowError(error) : null,
      })
      return
    }
    await this.options.store.updateScheduledTask(taskId, {
      status: 'active',
      lastFiredAt: nowUtc(),
      nextFireAt: computeNextFireAt({ cron, timezone, from: new Date() }),
      lastRunId: workflowRunId,
      failureCount,
      lastErrorMessage: error ? formatWorkflowError(error) : null,
    })
  }
}

function findNextNode(
  compiled: CompiledWorkflow,
  state: WorkflowExecutionState,
): { node: WorkflowNode; action: 'execute' | 'skip' } | null {
  for (const nodeId of compiled.topologicalOrder) {
    const current = nodeRun(state, nodeId)
    if (current.status !== 'pending') continue
    const node = compiled.nodesById.get(nodeId)
    if (!node) throw new Error(`编译结果缺少节点 '${nodeId}'。`)
    const incoming = compiled.incomingEdges.get(nodeId) ?? []
    if (incoming.length === 0) return { node, action: 'execute' }
    const sourceRuns = incoming.map(edge => nodeRun(state, edge.sourceNodeId))
    if (sourceRuns.some(source => !isTerminal(source.status))) continue
    const active = incoming.some(edge => (state.selectedPorts[edge.sourceNodeId] ?? []).includes(edge.sourcePort))
    return { node, action: active ? 'execute' : 'skip' }
  }
  return null
}

function completed(
  state: WorkflowExecutionState,
  node: WorkflowNode,
  output: Record<string, unknown>,
  ports: string[],
): { state: WorkflowExecutionState; paused: false } {
  const next = updateNodeRun(state, node.nodeId, {
    status: 'completed',
    completedAt: nowUtc(),
    errorMessage: null,
    output,
  })
  return {
    state: {
      ...next,
      nodeOutputs: { ...next.nodeOutputs, [node.nodeId]: output },
      selectedPorts: { ...next.selectedPorts, [node.nodeId]: ports },
      pendingApproval: next.pendingApproval?.nodeId === node.nodeId ? null : next.pendingApproval,
    },
    paused: false,
  }
}

function successPorts(compiled: CompiledWorkflow, nodeId: string): string[] {
  const edges = compiled.outgoingEdges.get(nodeId) ?? []
  const ports = new Set(edges
    .map(edge => edge.sourcePort)
    .filter(port => port === 'default' || port === 'success'))
  return ports.size ? [...ports] : ['default']
}

function updateNodeRun(
  state: WorkflowExecutionState,
  nodeId: string,
  patch: Partial<WorkflowNodeRun>,
): WorkflowExecutionState {
  let found = false
  const nodeRuns = state.nodeRuns.map(node => {
    if (node.nodeId !== nodeId) return node
    found = true
    return { ...node, ...patch }
  })
  if (!found) throw new Error(`Workflow 运行状态缺少节点 '${nodeId}'。`)
  return { ...state, nodeRuns }
}

function nodeRun(state: WorkflowExecutionState, nodeId: string): WorkflowNodeRun {
  const run = state.nodeRuns.find(node => node.nodeId === nodeId)
  if (!run) throw new Error(`Workflow 运行状态缺少节点 '${nodeId}'。`)
  return run
}

function bindingContext(state: WorkflowExecutionState): WorkflowBindingContext {
  return { prompt: state.prompt, parameters: state.parameters, nodeOutputs: state.nodeOutputs }
}

async function retry<T>(
  policy: { maxAttempts: number; backoffSeconds: number },
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < policy.maxAttempts && policy.backoffSeconds > 0) {
        await new Promise(resolve => setTimeout(resolve, policy.backoffSeconds * 1_000))
      }
    }
  }
  throw lastError
}

async function latestAssistantResponse(store: PlatformPersistenceFacade, threadId: string, runId: string): Promise<string> {
  const entries = await store.activeTranscript(threadId)
  const entry = [...entries].reverse().find(item => (
    item.runId === runId
    && item.kind === 'message'
    && item.payload.role === 'assistant'
    && typeof item.payload.content === 'string'
  ))
  if (!entry || typeof entry.payload.content !== 'string' || !entry.payload.content.trim()) {
    throw new Error('Agent 节点完成但没有可用的助手输出。')
  }
  return entry.payload.content.trim()
}

function isTerminal(status: WorkflowNodeRun['status']): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed' || status === 'cancelled'
}

function requireWorkflowRunId(payload: WorkflowJobPayload): string {
  if (!payload.workflowRunId) throw new Error('手动 Workflow job 缺少 workflowRunId。')
  return payload.workflowRunId
}

function requireOrchestrationRunId(state: WorkflowExecutionState): string {
  return requireString(state.orchestrationRunId, 'Workflow orchestrationRunId')
}

function requireString(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} 尚未建立。`)
  return value
}

function formatWorkflowError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Workflow 执行失败。'
}
