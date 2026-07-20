// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行与持久化协调器
//
//   文件:       toolExecutionCoordinator.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult, ValueRef } from '../framework/types.js'
import type { ModelAdapter } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import type { AuthContext } from '../security/types.js'
import { subAgentInvocationSchema, type AgentWorkflowStep, type TodoItem } from '../schemas/types.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'
import { makeId } from '../utils/ids.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink } from './turnRunner.js'
import {
  completeAgentWorkflowStep,
  failAgentWorkflowStep,
  findRunnableAgentWorkflowStep,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'

interface CoordinatorOptions {
  store: ToolExecutionStore
  registry: ToolRegistry
  adapter: ModelAdapter | null
  modelCompletions?: ModelCompletionService
  workspaceId: string | null
  runId: string
  sessionId: string
  threadId: string
  turnId: string
  modelName?: string | null
  inlineToolResultMaxChars: number
  runtimeConfig?: import('../schemas/types.js').AgentRuntimeConfig
  auth?: AuthContext | null
  eventSink: RunEventSink
  itemSink: ItemSink
  valueState: Map<string, unknown>
  signal: AbortSignal
  onPlanModeChanged?: (enabled: boolean) => void
}

// ToolExecutionCoordinator
//
// 自动 Agent 工具与确定性领域链共享这一执行路径；prepared 之后的每个状态
// 都先落盘再推进，未知副作用状态不会被包装成成功结果。
export class ToolExecutionCoordinator {
  private readonly preparedCalls = new Set<string>()
  private readonly callItems = new Map<string, string>()
  private readonly claimedWorkflowSteps = new Map<string, string>()
  private readonly externalAgentCalls = new Map<string, string>()
  private readonly pendingToolCallIds = new Set<string>()
  private workflowMutation: Promise<void> = Promise.resolve()
  private resultMutation: Promise<void> = Promise.resolve()
  private checkpointMutation: Promise<void> = Promise.resolve()
  private enteredPlanMode = false
  private activeHandoffAgentId: string | null = null

  constructor(private readonly options: CoordinatorOptions) {}

  isExecutionEnabled(): boolean {
    return !this.options.store.getRun(this.options.runId).state.planMode
  }

  enteredPlanModeDuringRun(): boolean {
    return this.enteredPlanMode
  }

  formatToolFailureForModel(toolName: string, message: string): string {
    const state = this.options.store.getRun(this.options.runId).state
    if (state.agentWorkflow?.status === 'adjusting' && state.failedTool === toolName) {
      return [
        `工具“${this.toolLabel(toolName)}”执行失败：${message}`,
        '当前智能体工作流已进入调整状态。',
        '不得重试失败步骤、绕过 Automation，或调用未批准的内部及替代工具。',
        '若有错误证据支持的新路径，必须调用 revise_agent_workflow 提交完整修订并重新审批；若缺少用户数据或选择，必须调用 request_clarification。',
      ].join(' ')
    }
    return `工具调用失败：${message}。请检查参数类型和必需字段后重试。`
  }

  formatUnavailableToolForModel(toolName: string): string {
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (workflow?.status === 'adjusting') {
      return [
        `工具 '${toolName}' 不在当前可用工具列表中。`,
        '当前智能体工作流正在等待调整，不得猜测工具名、绕过失败步骤或调用 Automation 内部工具。',
        '下一步只能调用 revise_agent_workflow 提交完整修订并重新审批，或调用 request_clarification 请求必要的用户输入。',
      ].join(' ')
    }
    return `工具 '${toolName}' 不在当前可用工具列表中。请只使用本轮公开的确切工具名；不存在合适能力时如实说明限制。`
  }

  // MCP、Skill 与沙箱工具还没有进入结构化工作流的步骤契约。普通执行可用，
  // 但规划阶段和已批准工作流期间必须关闭，避免审批后绕过步骤/参数边界。
  isSdkExtensionEnabled(): boolean {
    const state = this.options.store.getRun(this.options.runId).state
    return !state.planMode && state.agentWorkflow === null
  }

  isToolEnabled(toolName: string): boolean {
    const tool = this.options.registry.get(toolName)
    if (!tool) return false
    const state = this.options.store.getRun(this.options.runId).state
    if (state.planMode) {
      if (hasUnconsumedWorkflowRejection(state.approvals)) {
        return tool.planModeAccess === 'control'
      }
      return tool.planModeAccess !== undefined
    }
    if (!state.agentWorkflow) return true
    if (state.agentWorkflow.status === 'completed' || state.agentWorkflow.status === 'cancelled') return false
    if (ACTIVE_WORKFLOW_CONTROL_TOOLS.has(toolName)) return true
    return this.hasReadyWorkflowStep(toolName, 'supervisor')
  }

  isExternalAgentEnabled(agentId: string): boolean {
    const state = this.options.store.getRun(this.options.runId).state
    return !state.planMode && this.hasReadyWorkflowStep(agentId, agentId)
  }

  isHandoffEnabled(agentId: string): boolean {
    const state = this.options.store.getRun(this.options.runId).state
    return !state.planMode
      && state.agentWorkflow === null
      && (this.activeHandoffAgentId === null || this.activeHandoffAgentId === agentId)
  }

  activateHandoff(agentId: string): void {
    if (!this.isHandoffEnabled(agentId)) {
      throw new Error(`当前运行边界禁止转交给子智能体 '${agentId}'`)
    }
    this.activeHandoffAgentId = agentId
  }

  finishHandoff(agentId: string): void {
    if (this.activeHandoffAgentId === agentId) this.activeHandoffAgentId = null
  }

  activeHandoffAgent(): string | null {
    return this.activeHandoffAgentId
  }

  isToolEnabledForHandoff(agentId: string, toolName: string): boolean {
    return this.activeHandoffAgentId === agentId
      && Boolean(this.options.registry.get(toolName))
      && this.isHandoffEnabled(agentId)
  }

  isToolEnabledForSubAgent(agentId: string, toolName: string): boolean {
    if (!this.options.registry.get(toolName) || !this.isExecutionEnabled()) return false
    return [...this.externalAgentCalls.values()].some(candidate => candidate === agentId)
  }

  validateToolCall(toolName: string, args: Record<string, unknown>): string | null {
    if (!AGENT_WORKFLOW_DEFINITION_TOOLS.has(toolName)) return null
    return validateAgentWorkflowDraft(
      args,
      this.options.registry,
      this.options.runtimeConfig?.subAgents ?? [],
    )
  }

  async rejectPreparedToolCall(toolName: string, callId: string, message: string): Promise<void> {
    const itemId = this.callItems.get(callId)
    if (itemId) {
      this.options.itemSink.completeItem(itemId, {
        callId,
        name: toolName,
        body: message,
        isError: true,
        metadata: { toolLabel: this.toolLabel(toolName), rejectedBy: 'input_guardrail' },
      })
    }
    await this.updatePendingToolCall(callId, false)
  }

  async prepare(toolName: string, args: Record<string, unknown>, callId: string): Promise<void> {
    if (this.preparedCalls.has(callId)) return
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .some(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (existing) {
      this.preparedCalls.add(callId)
      return
    }
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: {
        callId,
        name: toolName,
        label: tool.label,
        arguments: args,
        ledgerStatus: 'prepared',
      },
    })
    await this.updatePendingToolCall(callId, true)
    const item = this.options.itemSink.startItem('function_call', {
      name: toolName,
      callId,
      arguments: JSON.stringify(args),
      metadata: { toolLabel: tool.label },
    })
    this.preparedCalls.add(callId)
    this.callItems.set(callId, item.itemId)
  }

  async prepareExternalAgentCall(
    agentId: string,
    agentName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    if (this.preparedCalls.has(callId)) return
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .some(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (existing) {
      this.preparedCalls.add(callId)
      return
    }
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: {
        callId,
        name: agentId,
        label: agentName,
        arguments: args,
        ledgerStatus: 'prepared',
      },
    })
    await this.updatePendingToolCall(callId, true)
    this.preparedCalls.add(callId)
  }

  // 并行批次的父调用只负责聚合多个子步骤，不直接占有某个 workflow step；
  // 但它仍是一个已准备的 SDK tool call，必须由同一协调器结清 checkpoint。
  async settlePreparedExternalAgentCall(callId: string): Promise<void> {
    await this.updatePendingToolCall(callId, false)
  }

  async executeForModel(toolName: string, args: Record<string, unknown>, callId: string): Promise<string> {
    const result = await this.execute(toolName, args, callId)
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      this.options.store.getRun(this.options.runId).state.planMode,
    )
  }

  async executeDirect(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = makeId('call')
    await this.prepare(toolName, args, callId)
    return this.execute(toolName, args, callId)
  }

  async beginExternalAgentStep(
    agentId: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string | null> {
    this.assertExecutionPhaseAllowsExternalAgent(agentId)
    const stepId = await this.claimAgentWorkflowStep(agentId, args, callId, agentId)
    this.externalAgentCalls.set(callId, agentId)
    return stepId
  }

  async completeExternalAgentStep(callId: string, summary: string): Promise<void> {
    try {
      await this.completeClaimedAgentWorkflowStep(callId, summary)
    } finally {
      this.externalAgentCalls.delete(callId)
      await this.updatePendingToolCall(callId, false)
    }
  }

  async failExternalAgentStep(callId: string, message: string): Promise<void> {
    try {
      await this.failClaimedAgentWorkflowStep(callId, message)
    } finally {
      this.externalAgentCalls.delete(callId)
      await this.updatePendingToolCall(callId, false)
    }
  }

  async executeForSubAgent(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    const result = await this.execute(toolName, args, callId, agentId)
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      this.options.store.getRun(this.options.runId).state.planMode,
    )
  }

  private async execute(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    ownerAgentId?: string,
  ): Promise<ToolResult> {
    this.options.signal.throwIfAborted()
    await this.prepare(toolName, args, callId)
    const itemId = this.callItems.get(callId)
    try {
      this.assertPlanModeAllows(toolName)
      if (ownerAgentId) this.assertExternalAgentIsRunning(ownerAgentId)
      else await this.claimAgentWorkflowStep(toolName, args, callId)
      await this.appendLedger(callId, toolName, 'started')
      const toolLabel = this.toolLabel(toolName)
      this.options.eventSink.emit('tool.started', toolLabel, { tool: toolName, toolLabel, callId })
      const result = await this.options.registry.execute(toolName, args, this.createToolContext())
      this.assertPlanModeDiscoveryResult(toolName, result)
      await this.enqueueResultMutation(async () => {
        await persistToolExecutionResult(
          this.options.store,
          this.options.runId,
          toolName,
          this.toolLabel(toolName),
          args,
          result,
        )
        if (typeof result.payload.planMode === 'boolean') {
          if (toolName === 'enter_plan_mode' && result.payload.planMode) {
            this.enteredPlanMode = true
          }
          this.options.onPlanModeChanged?.(result.payload.planMode)
        }
        this.emitAgentWorkflowControlEvent(toolName)
        await this.completeClaimedAgentWorkflowStep(callId, result.message)
        for (const ref of result.valueRefs ?? []) this.options.valueState.set(ref.refId, ref)
        this.options.eventSink.emit('tool.completed', result.message, {
          tool: toolName,
          toolLabel,
          callId,
          result: result.payload,
        })
        if (itemId) {
          this.options.itemSink.completeItem(itemId, {
            callId,
            name: toolName,
            output: JSON.stringify(result.payload),
            metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
          })
        }
        const outputItemId = this.options.itemSink.startItem('function_call_output', {
          callId,
          name: toolName,
          role: 'tool',
          metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
        }).itemId
        this.options.itemSink.completeItem(outputItemId, {
          callId,
          name: toolName,
          output: JSON.stringify(result.payload),
          metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], artifacts: result.artifacts ?? [] },
        })
        await this.appendToolResult(callId, toolName, result)
        await this.updatePendingToolCall(callId, false)
      })
      return result
    } catch (error) {
      const message = errorMessage(error)
      await this.enqueueResultMutation(async () => {
        await this.failClaimedAgentWorkflowStep(callId, message)
        await this.appendLedger(callId, toolName, 'failed', message)
        await this.appendToolFailure(callId, toolName, message)
        await this.options.store.mutateRunState(this.options.runId, state => ({
          warnings: [...state.warnings, `工具“${this.toolLabel(toolName)}”调用失败：${message}`],
          errors: [...state.errors, message],
          failedTool: toolName,
        }))
        if (itemId) this.options.itemSink.completeItem(itemId, {
          callId,
          name: toolName,
          isError: true,
          body: message,
          metadata: { toolLabel: this.toolLabel(toolName) },
        })
        // started 后失败是已知终态，可以清理 pending；进程直接崩溃时不会执行到这里。
        await this.updatePendingToolCall(callId, false)
      })
      throw error
    }
  }

  // 计划模式是能力白名单，不再把“只读”误当成“只用于规划”。查询完整要素、
  // 空间计算和图表生成即使不修改外部事实，也属于待审批的业务执行。
  private assertPlanModeAllows(toolName: string): void {
    const run = this.options.store.getRun(this.options.runId)
    if (!run.state.planMode) return
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.planModeAccess !== undefined) return
    throw new Error(`计划模式禁止执行未声明为规划发现或计划控制的工具 '${toolName}'。请先用 submit_agent_workflow 提交计划并等待批准。`)
  }

  async executeForHandoff(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    if (this.activeHandoffAgentId !== agentId) {
      throw new Error(`子智能体 '${agentId}' 尚未取得 handoff 所有权`)
    }
    const result = await this.execute(toolName, args, callId)
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      false,
    )
  }

  private assertExecutionPhaseAllowsExternalAgent(agentId: string): void {
    if (this.isExecutionEnabled()) return
    throw new Error(`计划模式禁止调用子智能体 '${agentId}'。请先用 submit_agent_workflow 提交计划并等待批准。`)
  }

  private assertPlanModeDiscoveryResult(toolName: string, result: ToolResult): void {
    const run = this.options.store.getRun(this.options.runId)
    const tool = this.options.registry.get(toolName)
    if (!run.state.planMode || tool?.planModeAccess !== 'discovery') return
    const createsArtifact = Boolean(result.artifacts?.length)
      || (result.valueRefs ?? []).some(ref => ['geojson', 'route', 'feature_collection'].includes(ref.kind))
      || Object.values(result.payload).some(isGeoJsonLike)
    if (createsArtifact) {
      throw new Error(`规划发现工具 '${toolName}' 返回了业务结果或 Artifact，违反计划模式契约。`)
    }
  }

  private assertExternalAgentIsRunning(agentId: string): void {
    const running = [...this.externalAgentCalls.values()].some(candidate => candidate === agentId)
    if (!running) {
      throw new Error(`子智能体 '${agentId}' 没有正在执行的已批准工作流步骤，不能调用平台工具。`)
    }
  }

  private claimAgentWorkflowStep(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    ownerAgentId?: string,
  ): Promise<string | null> {
    if (AGENT_WORKFLOW_CONTROL_TOOLS.has(toolName)) return Promise.resolve(null)
    return this.enqueueWorkflowMutation(async () => {
      let claimedStepId: string | null = null
      const updated = await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!workflow) return {}
        if (workflow.status === 'adjusting') {
          throw new Error('智能体工作流正在等待调整。请先调用 revise_agent_workflow，再执行后续工具。')
        }
        if (workflow.status === 'completed' || workflow.status === 'cancelled' || workflow.status === 'failed') {
          throw new Error(`智能体工作流已经处于 ${workflow.status} 状态，不能继续调用工具。`)
        }
        const claimed = new Set(this.claimedWorkflowSteps.values())
        const invocation = { toolName, args, ...(ownerAgentId ? { ownerAgentId } : {}) }
        const step = findRunnableAgentWorkflowStep(workflow, invocation, claimed)
        if (!step) {
          const planned = workflow.steps.filter(item => item.toolName === toolName && item.status === 'pending')
          const dependenciesSatisfied = planned.filter(item => item.dependsOn.every(dependency => (
            workflow.steps.some(candidate => (
              candidate.stepId === dependency
              && (candidate.status === 'completed' || candidate.status === 'skipped')
            ))
          )))
          if (ownerAgentId && dependenciesSatisfied.some(item => item.ownerAgentId !== ownerAgentId)) {
            throw new Error(`子智能体 '${ownerAgentId}' 不能领取分配给其他负责人的步骤。请先调用 revise_agent_workflow 调整负责人。`)
          }
          if (dependenciesSatisfied.length) {
            throw new Error(`工具 '${toolName}' 的实际参数超出当前工作流步骤声明。请按已批准参数执行，或先调用 revise_agent_workflow 显式调整工作流。`)
          }
          if (planned.length) {
            throw new Error(`工具 '${toolName}' 对应的计划步骤依赖尚未完成，不能提前执行。`)
          }
          throw new Error(`工具 '${toolName}' 不在当前智能体工作流的可执行步骤中。请先调用 revise_agent_workflow 显式调整工作流。`)
        }
        claimedStepId = step.stepId
        const next = startAgentWorkflowStep(workflow, { stepId: step.stepId })
        const nextStep = next.steps.find(item => item.stepId === step.stepId)
        if (!nextStep) throw new Error(`工具开始时智能体工作流步骤 '${step.stepId}' 不存在。`)
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      if (!claimedStepId) return null
      const next = updated.state.agentWorkflow
      if (!next) throw new Error('工具开始后智能体工作流状态缺失。')
      const step = next.steps.find(item => item.stepId === claimedStepId)
      if (!step) throw new Error(`工具开始后智能体工作流步骤 '${claimedStepId}' 不存在。`)
      const nextStep = next.steps.find(item => item.stepId === step.stepId)
      if (!nextStep) throw new Error(`工具开始时智能体工作流步骤 '${step.stepId}' 不存在。`)
      this.claimedWorkflowSteps.set(callId, step.stepId)
      this.options.eventSink.emit('step.started', step.title, {
        agentWorkflowId: next.agentWorkflowId,
        revision: next.revision,
        stepId: step.stepId,
        toolName,
      })
      return step.stepId
    })
  }

  private completeClaimedAgentWorkflowStep(callId: string, summary: string): Promise<void> {
    const stepId = this.claimedWorkflowSteps.get(callId)
    if (!stepId) return Promise.resolve()
    return this.enqueueWorkflowMutation(async () => {
      const updated = await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!workflow) throw new Error('工具完成时智能体工作流状态缺失。')
        const next = completeAgentWorkflowStep(workflow, { stepId, resultSummary: summary })
        const nextStep = next.steps.find(item => item.stepId === stepId)
        if (!nextStep) throw new Error(`工具完成时智能体工作流步骤 '${stepId}' 不存在。`)
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      const next = updated.state.agentWorkflow
      if (!next) throw new Error('工具完成后智能体工作流状态缺失。')
      const step = next.steps.find(item => item.stepId === stepId)
      if (!step) throw new Error(`工具完成后智能体工作流步骤 '${stepId}' 不存在。`)
      const nextStep = next.steps.find(item => item.stepId === stepId)
      if (!nextStep) throw new Error(`工具完成时智能体工作流步骤 '${stepId}' 不存在。`)
      this.claimedWorkflowSteps.delete(callId)
      this.options.eventSink.emit('step.completed', step.title, {
        agentWorkflowId: next.agentWorkflowId,
        revision: next.revision,
        stepId,
        toolName: step.toolName,
      })
      if (next.status === 'completed') {
        this.options.eventSink.emit('agent_workflow.completed', next.goal, {
          agentWorkflowId: next.agentWorkflowId,
          revision: next.revision,
        })
      }
    })
  }

  private failClaimedAgentWorkflowStep(callId: string, message: string): Promise<void> {
    const stepId = this.claimedWorkflowSteps.get(callId)
    if (!stepId) return Promise.resolve()
    return this.enqueueWorkflowMutation(async () => {
      const updated = await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!workflow) return {}
        const next = failAgentWorkflowStep(workflow, { stepId, errorMessage: message })
        const nextStep = next.steps.find(item => item.stepId === stepId)
        if (!nextStep) throw new Error(`工具失败时智能体工作流步骤 '${stepId}' 不存在。`)
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      const next = updated.state.agentWorkflow
      if (!next) return
      const nextStep = next.steps.find(item => item.stepId === stepId)
      if (!nextStep) throw new Error(`工具失败时智能体工作流步骤 '${stepId}' 不存在。`)
      this.claimedWorkflowSteps.delete(callId)
      this.options.eventSink.emit('warning.raised', `步骤执行失败：${message}`, {
        agentWorkflowId: next.agentWorkflowId,
        revision: next.revision,
        stepId,
      })
    })
  }

  private enqueueWorkflowMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.workflowMutation.then(operation, operation)
    this.workflowMutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private enqueueResultMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.resultMutation.then(operation, operation)
    this.resultMutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private updatePendingToolCall(callId: string, pending: boolean): Promise<void> {
    const operation = this.checkpointMutation.then(async () => {
      if (pending) this.pendingToolCallIds.add(callId)
      else this.pendingToolCallIds.delete(callId)
      const pendingToolCallIds = [...this.pendingToolCallIds]
      await this.options.store.saveRunCheckpoint(this.options.runId, {
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      })
    }, async () => {
      if (pending) this.pendingToolCallIds.add(callId)
      else this.pendingToolCallIds.delete(callId)
      const pendingToolCallIds = [...this.pendingToolCallIds]
      await this.options.store.saveRunCheckpoint(this.options.runId, {
        pendingToolCallIds,
        recoveryStatus: pendingToolCallIds.length ? 'requires_action' : 'clean',
      })
    })
    this.checkpointMutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private emitAgentWorkflowControlEvent(toolName: string): void {
    if (toolName !== 'submit_agent_workflow' && toolName !== 'revise_agent_workflow') return
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (!workflow) throw new Error('智能体工作流控制工具执行后没有写入工作流状态。')
    this.options.eventSink.emit(
      toolName === 'submit_agent_workflow' ? 'agent_workflow.created' : 'agent_workflow.revised',
      workflow.goal,
      {
        agentWorkflowId: workflow.agentWorkflowId,
        revision: workflow.revision,
        changeReason: workflow.changeReason,
      },
    )
  }

  private toolLabel(toolName: string): string {
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    return tool.label
  }

  private createToolContext(): ToolContext {
    const run = this.options.store.getRun(this.options.runId)
    return {
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      threadId: this.options.threadId,
      signal: this.options.signal,
      runtimeRoot: this.options.store.runtimeRoot,
      ...(this.options.runtimeConfig ? { runtimeConfig: this.options.runtimeConfig } : {}),
      auth: this.options.auth ?? null,
      state: this.options.valueState,
      resolveValueRef: refId => resolveRuntimeValueRef(this.options.valueState, refId),
      listMeteorologicalDatasets: input => this.options.store.listMeteorologicalDatasets({
        sessionId: this.options.sessionId,
        threadId: input?.scope === 'thread' ? this.options.threadId : null,
        workspaceId: run.workspaceId,
        filename: input?.filename ?? null,
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      }),
      resolveMeteorologicalDataset: input => this.options.store.resolveMeteorologicalDataset({
        sessionId: this.options.sessionId,
        threadId: null,
        workspaceId: run.workspaceId,
        datasetId: input.datasetId ?? null,
        filename: input.filename ?? null,
      }),
      invokeStructuredModel: async prompt => {
        if (!this.options.adapter) throw new Error('当前确定性工具链未配置结构化模型调用')
        if (this.options.modelCompletions && this.options.workspaceId) {
          const response = await this.options.modelCompletions.completeJson({
            workspaceId: this.options.workspaceId,
            runId: this.options.runId,
            provider: this.options.adapter.provider,
            ...(this.options.modelName === undefined ? {} : { model: this.options.modelName }),
            purpose: 'tool_structured_analysis',
            prompt,
            signal: this.options.signal,
          })
          await recordModelCompletionUsage(this.options.store, this.options.runId, response)
          return response.content
        }
        return invokeStructuredModel(this.options.adapter, prompt, this.options.modelName, this.options.signal)
      },
      log: (level, message) => this.options.eventSink.emit('tool.completed', message, { level }),
    }
  }

  private async appendToolResult(callId: string, toolName: string, result: ToolResult): Promise<void> {
    const content = JSON.stringify({
      message: result.message,
      payload: result.payload,
      valueRefs: (result.valueRefs ?? []).map(ref => ({ refId: ref.refId, kind: ref.kind, label: ref.label })),
    })
    const contentRef = content.length > this.options.inlineToolResultMaxChars
      ? await this.options.store.putConversationObject(content, 'application/json')
      : null
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId,
        name: toolName,
        label: this.toolLabel(toolName),
        summary: result.message,
        content: contentRef ? null : content,
        contentRef,
        ledgerStatus: 'completed',
        resultId: result.resultId,
      },
    })
  }

  private hasReadyWorkflowStep(toolName: string, ownerAgentId: string): boolean {
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (!workflow || workflow.status !== 'running') return false
    const completed = new Set(workflow.steps
      .filter(step => step.status === 'completed' || step.status === 'skipped')
      .map(step => step.stepId))
    const claimed = new Set(this.claimedWorkflowSteps.values())
    return workflow.steps.some(step => (
      step.status === 'pending'
      && step.toolName === toolName
      && step.ownerAgentId === ownerAgentId
      && !claimed.has(step.stepId)
      && step.dependsOn.every(dependency => completed.has(dependency))
    ))
  }

  private async appendToolFailure(callId: string, toolName: string, message: string): Promise<void> {
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId,
        name: toolName,
        label: this.toolLabel(toolName),
        summary: message,
        content: message,
        contentRef: null,
        ledgerStatus: 'failed',
        resultId: null,
      },
    })
  }

  private async appendLedger(
    callId: string,
    toolName: string,
    ledgerStatus: 'started' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'checkpoint',
      payload: {
        callId,
        name: toolName,
        label: this.toolLabel(toolName),
        ledgerStatus,
        error: error ?? null,
      },
    })
  }
}

function projectWorkflowStepToTodos(todos: TodoItem[], step: AgentWorkflowStep): TodoItem[] {
  const status = step.status === 'skipped' ? 'completed' : step.status
  return todos.map(todo => todo.stepId === step.stepId ? { ...todo, status } : todo)
}

function hasUnconsumedWorkflowRejection(
  approvals: ReadonlyArray<{ action: string; status: string; payload: Record<string, unknown> }>,
): boolean {
  return approvals.some(approval => (
    (approval.action === 'submit_agent_workflow' || approval.action === 'revise_agent_workflow')
    && approval.status === 'rejected'
    && approval.payload.consumed !== true
  ))
}

const AGENT_WORKFLOW_CONTROL_TOOLS = new Set([
  'request_clarification',
  'enter_plan_mode',
  'submit_agent_workflow',
  'revise_agent_workflow',
  'todo_write',
])

const AGENT_WORKFLOW_DEFINITION_TOOLS = new Set([
  'submit_agent_workflow',
  'revise_agent_workflow',
])

const ACTIVE_WORKFLOW_CONTROL_TOOLS = new Set([
  'request_clarification',
  'revise_agent_workflow',
])

export function validateAgentWorkflowDraft(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  subAgents: ReadonlyArray<{
    agentId: string
    tools?: string[]
    delegationMode?: 'as_tool' | 'parallel_batch' | 'handoff'
  }>,
): string | null {
  const workflow = isRecord(args.workflow) ? args.workflow : null
  const rawSteps = workflow && Array.isArray(workflow.steps) ? workflow.steps : []
  if (!rawSteps.length) return '工作流计划无效：至少需要一个可执行步骤。请依据执行能力目录修正后重新提交。'

  const steps = rawSteps.map((value, index) => ({ value: isRecord(value) ? value : null, index }))
  const stepIds = new Set<string>()
  const dependencies = new Map<string, string[]>()
  const subAgentConfigs = new Map(subAgents.map(agent => [agent.agentId, agent]))

  for (const { value: step, index } of steps) {
    if (!step) return `工作流计划无效：第 ${index + 1} 个步骤不是 JSON object。`
    const stepId = typeof step.stepId === 'string' ? step.stepId.trim() : ''
    const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : `第 ${index + 1} 个步骤`
    const kind = typeof step.kind === 'string' ? step.kind : ''
    const toolName = typeof step.toolName === 'string' ? step.toolName.trim() : ''
    const ownerAgentId = typeof step.ownerAgentId === 'string' ? step.ownerAgentId.trim() : ''
    if (!stepId) return `工作流计划无效：步骤“${title}”缺少 stepId。`
    if (stepIds.has(stepId)) return `工作流计划无效：stepId '${stepId}' 重复。`
    stepIds.add(stepId)

    if (kind === 'agent') {
      const subAgent = subAgentConfigs.get(toolName)
      if (!subAgent) {
        return `工作流计划无效：步骤“${title}”引用了未配置的子智能体 '${toolName}'。只能使用执行能力目录中的确切 agentId。`
      }
      if (subAgent.delegationMode === 'handoff') {
        return `工作流计划无效：Handoff 子智能体 '${toolName}' 会直接接管最终对话，不能作为需要返回 supervisor 的 workflow 步骤。`
      }
      if (ownerAgentId !== toolName) {
        return `工作流计划无效：子智能体步骤“${title}”的 ownerAgentId 必须等于 '${toolName}'。`
      }
      const invocation = subAgentInvocationSchema.safeParse(step.args)
      if (!invocation.success) {
        return `工作流计划无效：子智能体步骤“${title}”的 args 不符合结构化委托契约。`
      }
      const allowedTools = new Set(subAgent.tools ?? [])
      const invocationText = [
        invocation.data.objective,
        ...invocation.data.expectedDeliverables,
        ...invocation.data.contextRefs,
        ...invocation.data.constraints,
      ].join('\n')
      const mentionedTools = new Set(invocationText.match(/[A-Za-z][A-Za-z0-9_-]*/gu) ?? [])
      const unauthorized = registry.list()
        .map(definition => definition.name)
        .find(name => mentionedTools.has(name) && !allowedTools.has(name))
      if (unauthorized) {
        return `工作流计划无效：子智能体 '${toolName}' 的任务显式要求未授权工具 '${unauthorized}'。请改由 supervisor 执行，或调整为该子智能体目录中的授权工具。`
      }
    } else {
      const definition = registry.get(toolName)
      if (!definition || !(definition.executionSurfaces?.includes('agent') ?? true)) {
        return `工作流计划无效：步骤“${title}”引用了未注册的 Agent 工具 '${toolName}'。只能使用执行能力目录中的确切 toolName。`
      }
      if (AGENT_WORKFLOW_CONTROL_TOOLS.has(toolName)) {
        return `工作流计划无效：计划控制工具 '${toolName}' 不能作为业务执行步骤。`
      }
      if (ownerAgentId !== 'supervisor') {
        return `工作流计划无效：主智能体步骤“${title}”的 ownerAgentId 必须为 supervisor。`
      }
      if (kind === 'automation' && toolName !== 'execute_automation') {
        return `工作流计划无效：Automation 步骤“${title}”必须使用 execute_automation。`
      }
      if (kind !== 'automation' && toolName === 'execute_automation') {
        return `工作流计划无效：execute_automation 步骤“${title}”的 kind 必须为 automation。`
      }
      const stepArgs = isRecord(step.args) ? step.args : null
      if (!stepArgs) return `工作流计划无效：步骤“${title}”的 args 必须是 JSON object。`
      const argumentError = registry.validatePlannedArguments(toolName, stepArgs)
      if (argumentError) {
        return `工作流计划无效：步骤“${title}”的预计参数不符合 '${toolName}' 契约：${argumentError}。依赖前序结果的动态参数应从 args 省略，不得填写占位值。`
      }
    }

    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((value): value is string => typeof value === 'string')
      : []
    if (dependsOn.includes(stepId)) return `工作流计划无效：步骤 '${stepId}' 不能依赖自身。`
    dependencies.set(stepId, dependsOn)
  }

  for (const [stepId, dependsOn] of dependencies) {
    const unknown = dependsOn.find(dependency => !stepIds.has(dependency))
    if (unknown) return `工作流计划无效：步骤 '${stepId}' 依赖不存在的步骤 '${unknown}'。`
  }
  if (hasDependencyCycle(dependencies)) {
    return '工作流计划无效：步骤依赖形成了循环，无法确定执行顺序。'
  }
  return null
}

function hasDependencyCycle(dependencies: ReadonlyMap<string, string[]>): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true
    if (visited.has(stepId)) return false
    visiting.add(stepId)
    for (const dependency of dependencies.get(stepId) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(stepId)
    visited.add(stepId)
    return false
  }
  return [...dependencies.keys()].some(visit)
}

export function formatToolResultForModel(result: ToolResult, maxChars: number, planMode = false): string {
  const base = {
    message: result.message,
    valueRefs: summarizeValueRefs(result.valueRefs ?? []),
    artifacts: (result.artifacts ?? []).map(artifact => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
    })),
    ...(planMode ? {
      planningContract: {
        status: 'active',
        terminalTools: ['request_clarification', 'submit_agent_workflow'],
        requirement: '存在待执行目标时，本轮必须调用一个 terminalTools 工具；普通 assistant 正文不能结束规划。',
      },
    } : {}),
  }
  const full = JSON.stringify({ ...base, payload: result.payload })
  if (full.length <= maxChars) return full
  return JSON.stringify({ ...base, payloadSummary: summarizePayload(result.payload) })
}

function summarizeValueRefs(refs: ValueRef[]) {
  return refs.map(ref => ({
    refId: ref.refId,
    kind: ref.kind,
    label: ref.label,
    unit: ref.unit ?? null,
  }))
}

// 完整工具结果已经落盘到 run/transcript/artifact；模型继续推理只需要结构摘要和
// valueRef 清单。GeoJSON 的坐标通常占据绝大多数体积，但要素属性才是模型回答
// “有哪些对象”时的事实依据，因此压缩坐标、保留有界的属性行；其它大数组保留
// 长度与少量样例，避免后续工具从海量 payload 里误取 ref。
function summarizePayload(value: unknown, depth = 0): unknown {
  const featureCollection = summarizeFeatureCollection(value)
  if (featureCollection) return featureCollection
  if (depth > 3) return scalarSummary(value)
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 5).map(item => summarizePayload(item, depth + 1)),
    }
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return Object.fromEntries(entries.map(([key, item]) => [key, summarizePayload(item, depth + 1)]))
  }
  return value
}

const MAX_GEOJSON_PROPERTY_ROWS = 100

function summarizeFeatureCollection(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return null
  const propertyRows = value.features
    .slice(0, MAX_GEOJSON_PROPERTY_ROWS)
    .map((feature, index) => ({
      index,
      geometryType: isRecord(feature) && isRecord(feature.geometry) && typeof feature.geometry.type === 'string'
        ? feature.geometry.type
        : null,
      properties: isRecord(feature) && isRecord(feature.properties)
        ? summarizeFeatureProperties(feature.properties)
        : {},
    }))
  return {
    type: 'FeatureCollection',
    featureCount: value.features.length,
    propertyRows,
    propertyRowsComplete: value.features.length <= MAX_GEOJSON_PROPERTY_ROWS,
  }
}

function summarizeFeatureProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [key, value]
    return [key, scalarSummary(value)]
  }))
}

function scalarSummary(value: unknown): unknown {
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (isRecord(value)) return { type: 'object', keys: Object.keys(value).slice(0, 12) }
  return value
}

async function invokeStructuredModel(
  adapter: ModelAdapter,
  prompt: string,
  modelName?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await adapter.chat(prompt, {
    model: modelName ?? adapter.defaultModel,
    reasoning: false,
    ...(signal ? { signal } : {}),
  })
  const content = response.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回结构化内容')
  const cleaned = content.replace(/^```json\s*|\s*```$/gu, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object')
  return parsed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGeoJsonLike(value: unknown): boolean {
  if (!isRecord(value)) return false
  return [
    'FeatureCollection', 'Feature', 'LineString', 'Point', 'Polygon',
    'MultiLineString', 'MultiPoint', 'MultiPolygon', 'GeometryCollection',
  ].includes(String(value.type))
}
