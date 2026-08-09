// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行与持久化协调器
//
//   文件:       toolExecutionCoordinator.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult, ValueRef } from '../framework/types.js'
import type { ModelAdapter } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import { runSdkStructuredOutput } from '../model/sdkStructuredOutput.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import type { AuthContext } from '../security/types.js'
import {
  agentToolOutputMetadataSchema,
  subAgentInvocationSchema,
  type AgentToolOutputMetadata,
  type AgentWorkflow,
  type AgentWorkflowStep,
  type TodoItem,
} from '../schemas/types.js'
import { resolveRuntimeValueRef, type ToolResultCommitService } from '../tools/resultPersistence.js'
import { makeId } from '../utils/ids.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink } from './turnRunner.js'
import { developerToolsEnabledForRuntime, ToolExecutionPolicy } from './toolExecutionPolicy.js'
import {
  AGENT_WORKFLOW_CONTROL_TOOLS,
  completeAgentWorkflowStep,
  failAgentWorkflowStep,
  findRunnableAgentWorkflowStep,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'
import { validateGeospatialComposeWorkflowDraft } from './geospatialCompose.js'
import { ToolCallRecoveryLedger } from './toolCallRecoveryLedger.js'

interface CoordinatorOptions {
  store: ToolExecutionStore
  resultCommitService: Pick<ToolResultCommitService, 'commit'>
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
  subAgentConfigs?: import('../schemas/types.js').AgentRuntimeConfig['subAgents']
  auth?: AuthContext | null
  eventSink: RunEventSink
  itemSink: ItemSink
  valueState: Map<string, unknown>
  signal: AbortSignal
  onPlanModeChanged?: (enabled: boolean) => void
  initialPendingToolCallIds?: readonly string[]
}

interface ClaimedWorkflowStep {
  readonly agentWorkflowId: string
  readonly workflowRevision: number
  readonly objectiveRevision: number
  readonly stepId: string
  readonly attempt: number
  readonly startedAt: string
}

// ToolExecutionCoordinator
//
// 自动 Agent 工具与确定性领域链共享这一执行路径；prepared 之后的每个状态
// 都先落盘再推进，未知副作用状态不会被包装成成功结果。
export class ToolExecutionCoordinator {
  private readonly preparedCalls = new Set<string>()
  private readonly callItems = new Map<string, string>()
  private readonly claimedWorkflowSteps = new Map<string, ClaimedWorkflowStep>()
  private readonly externalAgentCalls = new Map<string, string>()
  private readonly outputMetadata = new Map<string, AgentToolOutputMetadata>()
  private readonly callObjectiveRevisions = new Map<string, number>()
  private modelInputObjectiveRevision: number
  private workflowMutation: Promise<void> = Promise.resolve()
  private resultMutation: Promise<void> = Promise.resolve()
  private readonly policy: ToolExecutionPolicy
  private readonly recoveryLedger: ToolCallRecoveryLedger

  constructor(private readonly options: CoordinatorOptions) {
    const objectiveRevision = options.store.getRun(options.runId).state.objectiveRevision
    this.modelInputObjectiveRevision = Number.isInteger(objectiveRevision) && objectiveRevision > 0
      ? objectiveRevision
      : 1
    this.recoveryLedger = new ToolCallRecoveryLedger(
      options.store,
      options.runId,
      options.initialPendingToolCallIds,
    )
    this.policy = new ToolExecutionPolicy({
      registry: options.registry,
      state: () => this.options.store.getRun(this.options.runId).state,
      claimedWorkflowSteps: () => this.activeClaimedWorkflowStepIds(
        this.options.store.getRun(this.options.runId).state.agentWorkflow,
      ),
      externalAgentCalls: () => this.externalAgentCalls,
      developerModeEnabled: () => this.options.runtimeConfig
        ? developerToolsEnabledForRuntime(this.options.runtimeConfig)
        : false,
    })
  }

  bindModelInputObjectiveRevision(objectiveRevision: number): void {
    if (!Number.isInteger(objectiveRevision) || objectiveRevision < 1) {
      throw new Error(`无效的模型输入 objective revision '${objectiveRevision}'`)
    }
    if (objectiveRevision < this.modelInputObjectiveRevision) {
      throw new Error(
        `模型输入 objective revision 不能从 ${this.modelInputObjectiveRevision} 回退到 ${objectiveRevision}`,
      )
    }
    this.modelInputObjectiveRevision = objectiveRevision
  }

  currentModelInputObjectiveRevision(): number {
    return this.modelInputObjectiveRevision
  }

  isExecutionEnabled(): boolean {
    return this.policy.isExecutionEnabled()
  }

  markSdkToolCallPending(callId: string): Promise<void> {
    return this.recoveryLedger.markPending(callId)
  }

  markSdkToolCallTerminal(callId: string): Promise<void> {
    return this.recoveryLedger.markTerminal(callId)
  }

  formatToolFailureForModel(toolName: string, message: string): string {
    const state = this.options.store.getRun(this.options.runId).state
    if (state.agentWorkflow?.status === 'adjusting' && state.failedTool === toolName) {
      return [
        `工具“${this.toolLabel(toolName)}”执行失败：${message}`,
        '工作流进度已记录该步骤失败。',
        '可以调用已注册的无副作用读取工具诊断原因；路径实质变化时用 revise_agent_workflow 更新工作流，缺少用户数据或选择时请求澄清。',
      ].join(' ')
    }
    return `工具调用失败：${message}。请检查参数类型和必需字段后重试。`
  }

  formatUnavailableToolForModel(toolName: string): string {
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (workflow?.status === 'adjusting') {
      return [
        `工具 '${toolName}' 不在当前可用工具列表中。`,
        '当前智能体工作流正在调整；只能使用已注册的无副作用读取工具诊断，或更新工作流、请求澄清。',
      ].join(' ')
    }
    return `工具 '${toolName}' 不在当前可用工具列表中。请只使用本轮公开的确切工具名；不存在合适能力时如实说明限制。`
  }

  // 任意 MCP 与沙箱执行还没有统一的读写语义契约，因此不能在规划或结构化
  // 工作流中按名称猜测其副作用。load_skill 不走此开关：它只物化配置快照，
  // 不授予 Skill 中后续操作的执行权限。
  isSdkExtensionEnabled(): boolean {
    return this.policy.isSdkExtensionEnabled()
  }

  isToolEnabled(toolName: string): boolean {
    return this.policy.isToolEnabled(toolName)
  }

  isExternalAgentEnabled(agentId: string): boolean {
    return this.policy.isExternalAgentEnabled(agentId)
  }

  isHandoffEnabled(agentId: string): boolean {
    return this.policy.isHandoffEnabled(agentId)
  }

  activateHandoff(agentId: string): void {
    this.policy.activateHandoff(agentId)
  }

  restoreHandoffOwnership(agentId: string): void {
    this.policy.restoreHandoffOwnership(agentId)
  }

  finishHandoff(agentId: string): void {
    this.policy.finishHandoff(agentId)
  }

  activeHandoffAgent(): string | null {
    return this.policy.activeHandoffAgent()
  }

  isToolEnabledForHandoff(agentId: string, toolName: string): boolean {
    return this.policy.isToolEnabledForHandoff(agentId, toolName)
  }

  isToolEnabledForSubAgent(agentId: string, toolName: string): boolean {
    return this.policy.isToolEnabledForSubAgent(agentId, toolName)
  }

  validateToolCall(toolName: string, args: Record<string, unknown>): string | null {
    if (!AGENT_WORKFLOW_DEFINITION_TOOLS.has(toolName)) return null
    const genericError = validateAgentWorkflowDraft(
      args,
      this.options.registry,
      this.options.subAgentConfigs ?? this.options.runtimeConfig?.subAgents ?? [],
    )
    if (genericError) return genericError
    const state = this.options.store.getRun(this.options.runId).state
    return state.runProfile === 'geospatial_compose'
      ? validateGeospatialComposeWorkflowDraft(
          args,
          this.options.registry,
          this.options.subAgentConfigs ?? this.options.runtimeConfig?.subAgents ?? [],
        )
      : null
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
    const invocation = splitWorkflowStepIdentity(args)
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (existing) {
      this.callObjectiveRevisions.set(callId, objectiveRevisionFromPayload(
        existing.payload,
        1,
      ))
      this.preparedCalls.add(callId)
      return
    }
    const objectiveRevision = this.modelInputObjectiveRevision
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: {
        callId,
        name: toolName,
        label: tool.label,
        arguments: invocation.toolArgs,
        workflowStepId: invocation.workflowStepId,
        objectiveRevision,
        ledgerStatus: 'prepared',
      },
    })
    const item = this.options.itemSink.startItem('function_call', {
      name: toolName,
      callId,
      arguments: JSON.stringify(invocation.toolArgs),
      metadata: { toolLabel: tool.label, objectiveRevision },
    })
    this.callObjectiveRevisions.set(callId, objectiveRevision)
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
    const invocation = splitWorkflowStepIdentity(args)
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (existing) {
      this.callObjectiveRevisions.set(callId, objectiveRevisionFromPayload(
        existing.payload,
        1,
      ))
      this.preparedCalls.add(callId)
      return
    }
    const objectiveRevision = this.modelInputObjectiveRevision
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: {
        callId,
        name: agentId,
        label: agentName,
        arguments: invocation.toolArgs,
        workflowStepId: invocation.workflowStepId,
        objectiveRevision,
        ledgerStatus: 'prepared',
      },
    })
    this.callObjectiveRevisions.set(callId, objectiveRevision)
    this.preparedCalls.add(callId)
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
    this.policy.assertExecutionPhaseAllowsExternalAgent(agentId)
    const { workflowStepId } = splitWorkflowStepIdentity(args)
    const stepId = await this.claimAgentWorkflowStep(agentId, callId, agentId, workflowStepId)
    this.externalAgentCalls.set(callId, agentId)
    await this.updatePendingToolCall(callId, true)
    return stepId
  }

  restoreExternalAgentStep(
    agentId: string,
    callId: string,
    stepId: string | null,
  ): void {
    const state = this.options.store.getRun(this.options.runId).state
    if (stepId) {
      const workflow = state.agentWorkflow
      const step = workflow?.steps.find(candidate => candidate.stepId === stepId)
      if (!workflow
        || !step
        || step.status !== 'running'
        || step.kind !== 'agent'
        || step.toolName !== agentId
        || step.ownerAgentId !== agentId) {
        throw new Error(`子智能体 '${agentId}' 的运行中工作流步骤 '${stepId}' 无法恢复`)
      }
      this.claimedWorkflowSteps.set(callId, workflowStepClaim(workflow, step))
    } else if (state.agentWorkflow) {
      throw new Error(`子智能体 '${agentId}' 缺少可恢复的工作流步骤`)
    }
    this.externalAgentCalls.set(callId, agentId)
  }

  async completeExternalAgentStep(callId: string, summary: string): Promise<void> {
    try {
      await this.completeClaimedAgentWorkflowStep(callId, summary)
    } finally {
      this.externalAgentCalls.delete(callId)
      await this.updatePendingToolCall(callId, false)
    }
  }

  toolOutputMetadata(callId: string): AgentToolOutputMetadata {
    const metadata = this.outputMetadata.get(callId)
    if (!metadata) throw new Error(`工具调用 '${callId}' 尚无可投影的输出元数据`)
    return metadata
  }

  private requireCallObjectiveRevision(callId: string): number {
    const objectiveRevision = this.callObjectiveRevisions.get(callId)
    if (objectiveRevision === undefined) {
      throw new Error(`工具调用 '${callId}' 缺少 objective revision 绑定`)
    }
    return objectiveRevision
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
    const objectiveRevision = this.requireCallObjectiveRevision(callId)
    const invocation = splitWorkflowStepIdentity(args)
    const itemId = this.callItems.get(callId)
    try {
      this.policy.assertPlanModeAllows(toolName)
      if (ownerAgentId) this.policy.assertExternalAgentIsRunning(ownerAgentId)
      else await this.claimAgentWorkflowStep(toolName, callId, undefined, invocation.workflowStepId)
      await this.updatePendingToolCall(callId, true)
      await this.appendLedger(callId, toolName, 'started', objectiveRevision)
      const toolLabel = this.toolLabel(toolName)
      this.options.eventSink.emit('tool.started', toolLabel, {
        tool: toolName,
        toolLabel,
        callId,
        objectiveRevision,
      })
      const existingArtifactIds = new Set(
        this.options.store.getRun(this.options.runId).state.artifacts.map(artifact => artifact.artifactId),
      )
      const result = await this.options.registry.execute(toolName, invocation.toolArgs, this.createToolContext())
      await this.enqueueResultMutation(async () => {
        const commit = await this.options.resultCommitService.commit({
          runId: this.options.runId,
          toolName,
          toolLabel: this.toolLabel(toolName),
          args: invocation.toolArgs,
          result,
          objectiveRevision,
        })
        if (commit.controlsApplied && typeof result.payload.planMode === 'boolean') {
          this.options.onPlanModeChanged?.(result.payload.planMode)
        }
        if (commit.controlsApplied) this.emitAgentWorkflowControlEvent(toolName)
        await this.completeClaimedAgentWorkflowStep(callId, result.message)
        for (const ref of result.valueRefs ?? []) this.options.valueState.set(ref.refId, ref)
        this.options.eventSink.emit('tool.completed', result.message, {
          tool: toolName,
          toolLabel,
          callId,
          result: result.payload,
          objectiveRevision,
        })
        if (itemId) {
          this.options.itemSink.completeItem(itemId, {
            callId,
            name: toolName,
            output: JSON.stringify(result.payload),
            metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [], objectiveRevision },
          })
        }
        const outputItemId = this.options.itemSink.startItem('function_call_output', {
          callId,
          name: toolName,
          role: 'tool',
          metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [], objectiveRevision },
        }).itemId
        this.options.itemSink.completeItem(outputItemId, {
          callId,
          name: toolName,
          output: JSON.stringify(result.payload),
          metadata: { toolLabel: this.toolLabel(toolName), resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], artifacts: result.artifacts ?? [], objectiveRevision },
        })
        await this.appendToolResult(callId, toolName, result, objectiveRevision)
        const generatedArtifactIds = this.options.store.getRun(this.options.runId).state.artifacts
          .map(artifact => artifact.artifactId)
          .filter(artifactId => !existingArtifactIds.has(artifactId))
        this.outputMetadata.set(callId, agentToolOutputMetadataSchema.parse({
          schemaVersion: 1,
          callId,
          toolName,
          resultId: result.resultId,
          valueRefIds: (result.valueRefs ?? []).map(reference => reference.refId),
          artifactIds: [...new Set([
            ...(result.artifacts ?? []).map(artifact => artifact.artifactId),
            ...generatedArtifactIds,
          ])],
          display: {
            label: toolLabel,
            summary: result.message,
            source: result.source,
          },
        }))
        await this.updatePendingToolCall(callId, false)
      })
      return result
    } catch (error) {
      const message = errorMessage(error)
      await this.enqueueResultMutation(async () => {
        await this.failClaimedAgentWorkflowStep(callId, message)
        await this.appendLedger(callId, toolName, 'failed', objectiveRevision, message)
        await this.appendToolFailure(callId, toolName, message, objectiveRevision)
        this.outputMetadata.set(callId, agentToolOutputMetadataSchema.parse({
          schemaVersion: 1,
          callId,
          toolName,
          resultId: null,
          valueRefIds: [],
          artifactIds: [],
          display: {
            label: this.toolLabel(toolName),
            summary: message,
            source: null,
          },
        }))
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
          metadata: { toolLabel: this.toolLabel(toolName), objectiveRevision },
        })
        // started 后失败是已知终态，可以清理 pending；进程直接崩溃时不会执行到这里。
        await this.updatePendingToolCall(callId, false)
      })
      throw error
    }
  }

  async executeForHandoff(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    if (this.policy.activeHandoffAgent() !== agentId) {
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

  private claimAgentWorkflowStep(
    toolName: string,
    callId: string,
    ownerAgentId?: string,
    workflowStepId?: string | null,
  ): Promise<string | null> {
    if (AGENT_WORKFLOW_CONTROL_TOOLS.has(toolName)) return Promise.resolve(null)
    return this.enqueueWorkflowMutation(async () => {
      let claimedStepId: string | null = null
      const updated = await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!workflow) return {}
        if (workflow.status === 'adjusting') {
          const tool = this.options.registry.get(toolName)
          if (tool?.isReadOnly && !tool.isDestructive) return {}
          throw new Error('智能体工作流正在等待调整。请先调用 revise_agent_workflow，再执行后续工具。')
        }
        if (workflow.status === 'completed' || workflow.status === 'cancelled' || workflow.status === 'failed') {
          throw new Error(`智能体工作流已经处于 ${workflow.status} 状态，不能继续调用工具。`)
        }
        const claimed = this.activeClaimedWorkflowStepIds(workflow)
        const invocation = {
          toolName,
          ...(ownerAgentId ? { ownerAgentId } : {}),
          ...(workflowStepId ? { workflowStepId } : {}),
        }
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
          if (workflowStepId) {
            const requested = workflow.steps.find(item => item.stepId === workflowStepId)
            if (!requested) throw new Error(`工作流步骤 '${workflowStepId}' 不存在。`)
            if (requested.toolName !== toolName) {
              throw new Error(`工作流步骤 '${workflowStepId}' 声明的工具是 '${requested.toolName}'，不能绑定到 '${toolName}'。`)
            }
            if (requested.ownerAgentId !== (ownerAgentId ?? 'supervisor')) {
              throw new Error(`工作流步骤 '${workflowStepId}' 不属于当前执行者。`)
            }
            if (requested.status !== 'pending' || claimed.has(requested.stepId)) {
              throw new Error(`工作流步骤 '${workflowStepId}' 当前不可领取。`)
            }
            throw new Error(`工作流步骤 '${workflowStepId}' 的依赖尚未完成，不能提前执行。`)
          }
          const readyForOwner = dependenciesSatisfied.filter(item => (
            item.ownerAgentId === (ownerAgentId ?? 'supervisor')
            && !claimed.has(item.stepId)
          ))
          if (readyForOwner.length > 1) {
            throw new Error(
              `工具 '${toolName}' 同时对应多个可执行步骤（${readyForOwner.map(item => item.stepId).join('、')}），`
              + '必须通过 workflowStepId 指定本次执行步骤。',
            )
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
      this.claimedWorkflowSteps.set(callId, workflowStepClaim(next, step))
      this.options.eventSink.emit('step.started', step.title, {
        agentWorkflowId: next.agentWorkflowId,
        revision: next.revision,
        objectiveRevision: next.objectiveRevision,
        stepId: step.stepId,
        attempt: step.attempt,
        toolName,
      })
      return step.stepId
    })
  }

  private completeClaimedAgentWorkflowStep(callId: string, summary: string): Promise<void> {
    const claim = this.claimedWorkflowSteps.get(callId)
    if (!claim) return Promise.resolve()
    return this.enqueueWorkflowMutation(async () => {
      const completion: {
        value?: { workflow: AgentWorkflow; step: AgentWorkflowStep }
      } = {}
      await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!matchingClaimedWorkflowStep(workflow, claim)) return {}
        const next = completeAgentWorkflowStep(workflow, {
          stepId: claim.stepId,
          resultSummary: summary,
        })
        const nextStep = next.steps.find(item => item.stepId === claim.stepId)
        if (!nextStep) return {}
        completion.value = { workflow: next, step: nextStep }
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      this.clearWorkflowClaim(callId, claim)
      const completed = completion.value
      if (!completed) return
      this.options.eventSink.emit('step.completed', completed.step.title, {
        agentWorkflowId: completed.workflow.agentWorkflowId,
        revision: completed.workflow.revision,
        objectiveRevision: completed.workflow.objectiveRevision,
        stepId: claim.stepId,
        attempt: claim.attempt,
        toolName: completed.step.toolName,
      })
      if (completed.workflow.status === 'completed') {
        this.options.eventSink.emit('agent_workflow.completed', completed.workflow.goal, {
          agentWorkflowId: completed.workflow.agentWorkflowId,
          revision: completed.workflow.revision,
          objectiveRevision: completed.workflow.objectiveRevision,
        })
      }
    })
  }

  private failClaimedAgentWorkflowStep(callId: string, message: string): Promise<void> {
    const claim = this.claimedWorkflowSteps.get(callId)
    if (!claim) return Promise.resolve()
    return this.enqueueWorkflowMutation(async () => {
      const failure: {
        value?: { workflow: AgentWorkflow; step: AgentWorkflowStep }
      } = {}
      await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!matchingClaimedWorkflowStep(workflow, claim)) return {}
        const next = failAgentWorkflowStep(workflow, {
          stepId: claim.stepId,
          errorMessage: message,
        })
        const nextStep = next.steps.find(item => item.stepId === claim.stepId)
        if (!nextStep) return {}
        failure.value = { workflow: next, step: nextStep }
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      this.clearWorkflowClaim(callId, claim)
      const failed = failure.value
      if (!failed) return
      this.options.eventSink.emit('warning.raised', `步骤执行失败：${message}`, {
        agentWorkflowId: failed.workflow.agentWorkflowId,
        revision: failed.workflow.revision,
        objectiveRevision: failed.workflow.objectiveRevision,
        stepId: claim.stepId,
        attempt: claim.attempt,
      })
    })
  }

  private clearWorkflowClaim(callId: string, claim: ClaimedWorkflowStep): void {
    if (this.claimedWorkflowSteps.get(callId) === claim) {
      this.claimedWorkflowSteps.delete(callId)
    }
  }

  private activeClaimedWorkflowStepIds(workflow: AgentWorkflow | null): Set<string> {
    return new Set(
      [...this.claimedWorkflowSteps.values()]
        .filter(claim => matchingClaimedWorkflowStep(workflow, claim))
        .map(claim => claim.stepId),
    )
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
    return pending
      ? this.recoveryLedger.markPending(callId)
      : this.recoveryLedger.markTerminal(callId)
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
      listMeteorologicalDatasets: input => this.options.store.meteorology.listMeteorologicalDatasets({
        sessionId: this.options.sessionId,
        threadId: input?.scope === 'thread' ? this.options.threadId : null,
        workspaceId: run.workspaceId,
        filename: input?.filename ?? null,
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      }),
      resolveMeteorologicalDataset: input => this.options.store.meteorology.resolveMeteorologicalDataset({
        sessionId: this.options.sessionId,
        threadId: input.selector === 'current_thread_latest' ? this.options.threadId : null,
        workspaceId: run.workspaceId,
        datasetId: input.selector === 'explicit_dataset_id' ? input.datasetId : 'latest_upload',
        filename: input.selector === 'current_thread_latest' ? input.filename ?? null : null,
      }),
      resolveMeteorologicalDatasets: datasetIds => this.options.store.meteorology.listMeteorologicalDatasets({
        datasetIds,
        workspaceId: run.workspaceId,
        sessionId: run.workspaceId ? null : this.options.sessionId,
        limit: Math.max(1, datasetIds.length),
      }),
      invokeStructuredModel: async (prompt, schema, options) => {
        if (!this.options.adapter) throw new Error('当前确定性工具链未配置结构化模型调用')
        if (this.options.modelCompletions && this.options.workspaceId) {
          const response = await this.options.modelCompletions.completeStructured({
            workspaceId: this.options.workspaceId,
            runId: this.options.runId,
            provider: this.options.adapter.provider,
            ...(this.options.modelName === undefined ? {} : { model: this.options.modelName }),
            purpose: 'tool_structured_analysis',
            prompt,
            ...(options?.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
            signal: this.options.signal,
          }, schema)
          await recordModelCompletionUsage(this.options.store, this.options.runId, response)
          return response.content
        }
        const modelName = this.options.modelName ?? this.options.adapter.defaultModel
        if (!modelName) throw new Error(`模型 provider '${this.options.adapter.provider}' 未配置模型名称`)
        return (await runSdkStructuredOutput(
          this.options.adapter,
          modelName,
          prompt,
          schema,
          this.options.signal,
        )).content
      },
      log: (level, message) => this.options.eventSink.emit('tool.completed', message, { level }),
    }
  }

  private async appendToolResult(
    callId: string,
    toolName: string,
    result: ToolResult,
    objectiveRevision: number,
  ): Promise<void> {
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
        objectiveRevision,
        name: toolName,
        label: this.toolLabel(toolName),
        summary: result.message,
        content: contentRef ? null : content,
        contentRef,
        ledgerStatus: 'completed',
        resultId: result.resultId,
        valueRefIds: (result.valueRefs ?? []).map(reference => reference.refId),
        artifactIds: (result.artifacts ?? []).map(artifact => artifact.artifactId),
      },
    })
  }

  private async appendToolFailure(
    callId: string,
    toolName: string,
    message: string,
    objectiveRevision: number,
  ): Promise<void> {
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId,
        objectiveRevision,
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
    objectiveRevision: number,
    error?: string,
  ): Promise<void> {
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'checkpoint',
      payload: {
        callId,
        objectiveRevision,
        name: toolName,
        label: this.toolLabel(toolName),
        ledgerStatus,
        error: error ?? null,
      },
    })
  }
}

function workflowStepClaim(
  workflow: AgentWorkflow,
  step: AgentWorkflowStep,
): ClaimedWorkflowStep {
  if (step.status !== 'running' || !step.startedAt) {
    throw new Error(`工作流步骤 '${step.stepId}' 缺少可恢复的运行身份`)
  }
  return Object.freeze({
    agentWorkflowId: workflow.agentWorkflowId,
    workflowRevision: workflow.revision,
    objectiveRevision: workflow.objectiveRevision,
    stepId: step.stepId,
    attempt: step.attempt,
    startedAt: step.startedAt,
  })
}

function matchingClaimedWorkflowStep(
  workflow: AgentWorkflow | null,
  claim: ClaimedWorkflowStep,
): workflow is AgentWorkflow {
  if (!workflow
    || workflow.agentWorkflowId !== claim.agentWorkflowId
    || workflow.revision !== claim.workflowRevision
    || workflow.objectiveRevision !== claim.objectiveRevision) {
    return false
  }
  const step = workflow.steps.find(candidate => candidate.stepId === claim.stepId)
  return step?.status === 'running'
    && step.attempt === claim.attempt
    && step.startedAt === claim.startedAt
}

function projectWorkflowStepToTodos(todos: TodoItem[], step: AgentWorkflowStep): TodoItem[] {
  const status = step.status === 'skipped' ? 'completed' : step.status
  return todos.map(todo => todo.stepId === step.stepId ? { ...todo, status } : todo)
}

const AGENT_WORKFLOW_DEFINITION_TOOLS = new Set([
  'submit_agent_workflow',
  'revise_agent_workflow',
])

export function validateAgentWorkflowDraft(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  subAgents: ReadonlyArray<{
    agentId: string
    tools?: string[]
    delegationMode?: 'as_tool' | 'handoff'
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
      planningContext: {
        status: 'active',
        actions: ['继续无副作用读取', 'request_clarification', 'submit_agent_workflow', '直接说明计划'],
        guidance: '结构化工作流用于后续进度投影；计划本身不会替代有副作用工具各自的审批。',
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

function splitWorkflowStepIdentity(args: Record<string, unknown>): {
  workflowStepId: string | null
  toolArgs: Record<string, unknown>
} {
  const raw = args.workflowStepId
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !raw.trim())) {
    throw new Error('workflowStepId 必须是非空字符串或 null。')
  }
  const toolArgs = { ...args }
  delete toolArgs.workflowStepId
  return {
    workflowStepId: typeof raw === 'string' ? raw.trim() : null,
    toolArgs,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function objectiveRevisionFromPayload(payload: Record<string, unknown>, fallback: number): number {
  const value = payload.objectiveRevision
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
