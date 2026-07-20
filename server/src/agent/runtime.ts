// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK 运行时
//
//   文件:       runtime.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { errorLogPayload, logger } from '../observability/logger.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import {
  Agent,
  RunContext,
  Runner,
  RunState,
  type AgentInputItem,
  type Tool,
} from '@openai/agents'
import {
  SandboxAgent,
  compaction,
  filesystem,
  shell,
  type Capability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox'
import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapter, ModelAdapterRegistry } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import type {
  AgentRuntimeConfig,
  AnalysisRun,
  SupervisorDelivery,
  ToolValueRef,
} from '../schemas/types.js'
import { supervisorDeliverySchema } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { buildPlanningCapabilityCatalog, buildSystemPrompt } from './prompts.js'
import { buildMemoryPrompt, createMemoryRuntime, dreamMemories, extractMemoriesFromThread, rebuildSessionMemory } from '../memory/service.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
} from './contextManager.js'
import { FileAgentsSession } from './fileAgentsSession.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import { agentsSdkVersion, runtimeConfigDigest } from './agentsRuntimeMetadata.js'
import type { AuthContext } from '../security/types.js'
import {
  assistantText,
  conversationMessagesToAgentItems,
  errorMessage,
  functionCallId,
  isAssistantMessage,
  modelSettings,
  parseStructuredJson,
  requireString,
  requireThreadId,
  sdkNativeLedgerStatus,
  toolResultText,
} from './runtimeSdkProjection.js'
import { approvalRejectionMessage, resolveDecision } from './runtimeApprovals.js'
import {
  buildSandboxManifest,
  createConfiguredSandboxSession,
  prepareRunArtifactDirectory,
  type SandboxSessionFactory,
} from './runtimeSandbox.js'
import {
  buildRuntimeSdkSandboxIntegration,
  createRuntimeSdkIntegration,
  type RuntimeSdkIntegration,
} from './runtimeSdkIntegrations.js'
import { aggregateModelUsage, mergeModelUsageStats, type ModelUsageLike } from './modelUsage.js'
import { AgentsCheckpointService } from './agentsCheckpointService.js'
import { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import { RunSteeringController } from './runSteeringController.js'
import type { RunOptions, RuntimeAssembly, StreamProjectionState } from './runtimeTypes.js'
import { createSubAgentTools } from './subAgentToolFactory.js'
import { createParallelSubAgentTool, PARALLEL_SUBAGENT_TOOL_NAME } from './parallelSubAgentToolFactory.js'
import { createHandoffAgents } from './handoffAgentFactory.js'
import { SubAgentStateController } from './subAgentRuntimeSupport.js'
import {
  createPlanModeTerminalGuardrail,
  planModeTerminalGuardrailMessage,
} from './runtimeOutputGuardrails.js'

export type { SandboxSessionFactory } from './runtimeSandbox.js'
export type { RunOptions } from './runtimeTypes.js'

export interface OpenAIAgentsRuntimeOptions {
  createSandboxSession?: SandboxSessionFactory
  agentTracing?: LocalAgentTracing
}

// OpenAIAgentsRuntime
//
// Runner 是单次 run 内编排的唯一状态机；本类只投影 SDK 事件并维护 GeoForge
// 内容载荷存储、审批边界和通用工具/Automation 入口。
export class OpenAIAgentsRuntime {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly checkpoints: AgentsCheckpointService
  private readonly transcriptProjector: RuntimeTranscriptProjector
  private readonly approvalPersistence: RuntimeApprovalPersistence
  private readonly steering: RunSteeringController

  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly modelRegistry: ModelAdapterRegistry,
    private readonly runtimeOptions: OpenAIAgentsRuntimeOptions = {},
    private readonly modelCompletions?: ModelCompletionService,
  ) {
    this.checkpoints = new AgentsCheckpointService(store)
    this.transcriptProjector = new RuntimeTranscriptProjector(store, toolRegistry)
    this.approvalPersistence = new RuntimeApprovalPersistence(store, toolRegistry, this.checkpoints)
    this.steering = new RunSteeringController(store)
  }

  async run(options: RunOptions): Promise<AnalysisRun> {
    const threadId = requireThreadId(options.threadId)
    const eventSink = new RunEventSink(event => this.store.appendEvent(options.runId, event), options.runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), options.runId, threadId)
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(options.runId, status))
    const abort = new AbortController()
    const unlinkExternalAbort = linkAbortSignal(options.signal, abort)
    if (this.abortControllers.has(options.runId)) {
      unlinkExternalAbort()
      throw new Error(`运行 '${options.runId}' 已有活动执行器`)
    }
    this.abortControllers.set(options.runId, abort)
    let detachTracing = (): void => {}
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(options.runId, eventSink) ?? (() => {})
      await this.store.updateRunStatus(options.runId, 'running')
      if (!options.resume && options.executionMode === 'plan') {
        await this.store.updateRunState(options.runId, {
          planMode: true,
          agentWorkflow: null,
        })
      }

      const turnId = options.resume
        ? await this.checkpoints.requireTurnId(threadId, options.runId)
        : makeId('turn')
      if (!options.resume) {
        const userEntry = await this.store.appendTranscript({
          threadId,
          runId: options.runId,
          turnId,
          kind: 'message',
          payload: { role: 'user', content: options.query },
        })
        itemSink.appendUserMessage(options.query, { transcriptEntryId: userEntry.entryId })
        eventSink.emit('intent.parsed', '开始分析...', {})
      }

      await this.steering.open(options.runId)
      const assembly = await this.assembleRuntime(options, threadId, turnId, eventSink, itemSink, abort.signal)
      const resumeState = options.resume
        ? await this.checkpoints.restore({
          runId: options.runId,
          agent: assembly.agent,
          context: assembly.context,
          sdkVersion: assembly.sdkVersion,
          configDigest: assembly.configDigest,
        })
        : null
      const completed = await this.executeSdkRun(
        options,
        assembly,
        resumeState,
        abort.signal,
        eventSink,
        itemSink,
      )
      if (completed === 'waiting_approval') return this.store.getRun(options.runId)
      if (completed === 'clarification_needed') return this.store.getRun(options.runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
      return this.store.getRun(options.runId)
    } catch (error) {
      const message = planModeTerminalGuardrailMessage(error) ?? errorMessage(error)
      logger.error({ message }, 'run failed')
      if (abort.signal.aborted) {
        await finalizer.cancel()
      } else {
        const current = this.store.getRun(options.runId)
        await this.store.updateRunState(options.runId, { errors: [...current.state.errors, message] })
        await finalizer.fail(message)
      }
      return this.store.getRun(options.runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(options.runId)
        } finally {
          unlinkExternalAbort()
          this.abortControllers.delete(options.runId)
        }
      }
    }
  }

  async cancel(runId: string): Promise<AnalysisRun> {
    const controller = this.abortControllers.get(runId)
    if (!controller) throw new Error(`运行 '${runId}' 不可取消`)
    controller.abort()
    return this.store.updateRunStatus(runId, 'cancelled')
  }

  steer(runId: string, steeringId: string, content: string) {
    return this.steering.enqueue(runId, steeringId, content)
  }

  async acceptApprovalDecision(
    runId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<{ run: AnalysisRun; accepted: boolean }> {
    const run = this.store.getRun(runId)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    if (approval.payload.consumed === true) {
      return { run, accepted: false }
    }

    const expectedStatus = approved ? 'approved' : 'rejected'
    // WS 在审批已经落盘、后台任务尚未成功登记时断开，可以安全重试同一决定。
    // 只允许 queued 状态重试；一旦续跑进入 running/failed，禁止重放副作用。
    if (approval.status === expectedStatus) {
      return { run, accepted: run.status === 'queued' }
    }
    if (approval.status !== 'pending') return { run, accepted: false }

    const resolvedApproval = {
      ...approval,
      status: approved ? 'approved' as const : 'rejected' as const,
      resolvedAt: nowUtc(),
    }
    await this.store.updateRunState(runId, {
      approvals: run.state.approvals.map(candidate => candidate.approvalId === approvalId
        ? resolvedApproval
        : candidate),
      decisions: resolveDecision(run.state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved }),
    })
    await this.store.updateRunStatus(runId, 'queued')
    return { run: this.store.getRun(runId), accepted: true }
  }

  async continueApprovalDecision(
    runId: string,
    approvalId: string,
    approved: boolean,
    auth?: AuthContext | null,
    signal?: AbortSignal,
  ): Promise<AnalysisRun> {
    const run = this.store.getRun(runId)
    if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
    if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    const expectedStatus = approved ? 'approved' : 'rejected'
    if (approval.status !== expectedStatus || approval.payload.consumed === true) {
      throw new Error(`审批 '${approvalId}' 未处于可续跑的 ${expectedStatus} 状态`)
    }
    const eventSink = new RunEventSink(event => this.store.appendEvent(runId, event), runId, run.threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), runId, run.threadId)
    const turnId = requireString(approval.payload.turnId, '审批 payload.turnId')
    const options: RunOptions = {
      runId,
      threadId: run.threadId,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: requireString(run.modelProvider, '运行 modelProvider'),
      modelName: run.modelName,
      runtimeConfig: run.runtimeConfigSnapshot,
      reasoning: true,
      resume: true,
      auth: auth ?? null,
    }
    const abort = new AbortController()
    const unlinkExternalAbort = linkAbortSignal(signal, abort)
    if (this.abortControllers.has(runId)) {
      unlinkExternalAbort()
      throw new Error(`运行 '${runId}' 已有活动执行器`)
    }
    this.abortControllers.set(runId, abort)
    let detachTracing = (): void => {}
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(runId, eventSink) ?? (() => {})
      await this.store.updateRunStatus(runId, 'running')
      await this.steering.open(runId)
      const assembly = await this.assembleRuntime(options, run.threadId, turnId, eventSink, itemSink, abort.signal, false)
      const state = await this.checkpoints.restore({
        runId: options.runId,
        agent: assembly.agent,
        context: assembly.context,
        sdkVersion: assembly.sdkVersion,
        configDigest: assembly.configDigest,
      })
      const callId = requireString(approval.payload.callId, '审批 payload.callId')
      const interruption = state.getInterruptions().find(item => functionCallId(item) === callId)
      if (!interruption) throw new Error(`SDK 状态中不存在待审批调用 '${callId}'`)
      if (approved) state.approve(interruption)
      else state.reject(interruption, { message: approvalRejectionMessage(approval.action) })

      const result = await this.executeSdkRun(options, assembly, state, abort.signal, eventSink, itemSink)
      // executeSdkRun 可能在拒绝后立即产生一条新的审批。必须以刚落盘的
      // run state 为事实源，只消费当前审批，不能用恢复前的 approvals 快照
      // 覆盖新审批，否则前端会拿到一个在 approvals 中已经消失的 decisionId。
      const latest = this.store.getRun(runId)
      await this.store.updateRunState(runId, {
        approvals: latest.state.approvals.map(candidate => candidate.approvalId === approvalId
          ? { ...candidate, payload: { ...candidate.payload, consumed: true } }
          : candidate),
        decisions: resolveDecision(latest.state.decisions, approvalId, approved ? 'approved' : 'rejected', { approved, consumed: true }),
      })
      if (result === 'waiting_approval') return this.store.getRun(runId)
      if (result === 'clarification_needed') return this.store.getRun(runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, run.threadId, eventSink)
      return this.store.getRun(runId)
    } catch (error) {
      const message = planModeTerminalGuardrailMessage(error) ?? errorMessage(error)
      if (abort.signal.aborted) {
        await finalizer.cancel()
      } else {
        const current = this.store.getRun(runId)
        await this.store.updateRunState(runId, { errors: [...current.state.errors, message] })
        await finalizer.fail(message)
      }
      return this.store.getRun(runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(runId)
        } finally {
          unlinkExternalAbort()
          this.abortControllers.delete(runId)
        }
      }
    }
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean, auth?: AuthContext | null): Promise<AnalysisRun> {
    const receipt = await this.acceptApprovalDecision(runId, approvalId, approved)
    if (!receipt.accepted) return receipt.run
    return this.continueApprovalDecision(runId, approvalId, approved, auth)
  }

  private createThreadValueState(threadId: string, currentRunId: string): Map<string, unknown> {
    const refs = this.visibleThreadValueRefs(threadId, currentRunId)
    return new Map<string, unknown>(refs.map(ref => [ref.refId, ref]))
  }

  private visibleThreadValueRefs(threadId: string, currentRunId: string): ToolValueRef[] {
    const currentRun = this.store.getRun(currentRunId)
    const currentCreatedAt = Date.parse(currentRun.createdAt)
    const priorRuns = this.store.listRunsForThread(threadId)
      .filter(run => run.id !== currentRunId && Date.parse(run.createdAt) <= currentCreatedAt)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

    // 连续对话会把上一轮 tool_result 作为可见上下文交给模型；运行时黑板必须恢复
    // 同一 thread 中已落盘的 valueRef，否则模型可见的 refId 会在执行边界变成未知引用。
    return [
      ...priorRuns.flatMap(run => run.state.toolValueRefs),
      ...currentRun.state.toolValueRefs,
    ]
  }

  private async assembleRuntime(
    options: RunOptions,
    threadId: string,
    turnId: string,
    eventSink: RunEventSink,
    itemSink: ItemSink,
    signal: AbortSignal,
    maintainContext = true,
  ): Promise<RuntimeAssembly> {
    const adapter = this.modelRegistry.resolveProvider(options.provider)
    const workspaceId = this.store.getRun(options.runId).workspaceId
    if (!adapter.createAgentModel) throw new Error(`模型 provider '${adapter.provider}' 不支持 Agents SDK Supervisor`)
    assertAgentRuntimeCapabilities(adapter, options.runtimeConfig)
    const selectedModel = options.modelName ?? adapter.defaultModel
    if (!selectedModel) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
    const model = adapter.createAgentModel(selectedModel)
    const contextConfig = {
      ...options.runtimeConfig.context,
      contextWindowTokens: adapter.contextWindowTokens ?? options.runtimeConfig.context.contextWindowTokens,
    }
    const summarize = async (prompt: string) => {
      const summaryAdapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
      const summaryModel = options.runtimeConfig.context.summaryModel
        ?? summaryAdapter.subagentModel
        ?? selectedModel
      if (!summaryModel) throw new Error('未配置摘要模型')
      if (this.modelCompletions && workspaceId) {
        const response = await this.modelCompletions.completeText({
          workspaceId,
          runId: options.runId,
          provider: summaryAdapter.provider,
          model: summaryModel,
          purpose: 'thread_summary',
          prompt,
          signal,
        })
        await recordModelCompletionUsage(this.store, options.runId, response)
        return response.content
      }
      const response = await summaryAdapter.chat(prompt, { model: summaryModel, reasoning: false, signal })
      if (typeof response.content !== 'string' || !response.content.trim()) throw new Error('摘要模型未返回文本')
      return response.content
    }
    if (maintainContext) {
      await compactThreadIfNeeded(this.store, threadId, contextConfig, summarize)
      try {
        await rebuildSessionMemory(this.store, threadId, contextConfig, summarize, false, options.runId)
      } catch (error) {
        await this.recordWarning(options.runId, `会话记忆更新失败：${errorMessage(error)}`, eventSink)
      }
    }
    const run = this.store.getRun(options.runId)
    const memoryToolsAvailable = this.memoryToolsAvailable()
    const memoryPrompt = await buildMemoryPrompt(createMemoryRuntime(this.store.runtimeRoot, contextConfig), memoryToolsAvailable)
    const buildSupervisorInstructions = (): string => {
      const currentState = this.store.getRun(options.runId).state
      const planningCatalog = currentState.planMode
        ? buildPlanningCapabilityCatalog(this.toolRegistry.list(), options.runtimeConfig.subAgents)
        : ''
      return buildSystemPrompt(options.runtimeConfig, currentState, planningCatalog, '', memoryPrompt)
    }
    const systemPrompt = buildSupervisorInstructions()
    const assembled = await assembleThreadContext(this.store, threadId, contextConfig, systemPrompt)
    await this.store.updateRunState(options.runId, {
      runtimeStats: {
        ...run.state.runtimeStats,
        contextEstimatedTokens: assembled.report.estimatedTokens,
        contextUsagePermille: Math.round(assembled.report.usageRatio * 1000),
      },
    })

    const valueState = this.createThreadValueState(threadId, options.runId)
    let coordinator: ToolExecutionCoordinator
    const coreSandboxCapabilities = planAwareSandboxCapabilities()
    const context: AgentsExecutionContext = {
      runId: options.runId,
      isExecutionEnabled: () => coordinator.isExecutionEnabled(),
      isSdkExtensionEnabled: () => coordinator.isSdkExtensionEnabled(),
      isToolEnabled: toolName => coordinator.isToolEnabled(toolName),
      validateToolCall: (toolName, args) => coordinator.validateToolCall(toolName, args),
      formatToolFailureForModel: (toolName, message) => coordinator.formatToolFailureForModel(toolName, message),
      rejectPreparedToolCall: (toolName, callId, message) => coordinator.rejectPreparedToolCall(toolName, callId, message),
      prepareToolCall: (toolName, args, callId) => coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => coordinator.executeForModel(toolName, args, callId),
    }
    coordinator = new ToolExecutionCoordinator({
      store: this.store,
      registry: this.toolRegistry,
      adapter,
      ...(this.modelCompletions ? { modelCompletions: this.modelCompletions } : {}),
      workspaceId,
      runId: options.runId,
      sessionId: options.sessionId,
      threadId,
      turnId,
      modelName: selectedModel,
      inlineToolResultMaxChars: options.runtimeConfig.context.inlineToolResultMaxChars,
      runtimeConfig: options.runtimeConfig,
      auth: options.auth ?? null,
      eventSink,
      itemSink,
      valueState,
      signal,
    })
    const approvalTools = new Set(options.runtimeConfig.supervisor.approvalInterruptTools)
    const returnDirectToolNames = this.toolRegistry.list()
      .filter(tool => (tool.executionSurfaces?.includes('agent') ?? true) && tool.agentResultMode === 'return_direct')
      .map(tool => tool.name)
    const supervisorTools = wrapReturnDirectTools(
      createAgentsTools(this.toolRegistry, approvalTools, {
        schemaMode: adapter.agentToolSchemaMode,
      }),
      new Set(returnDirectToolNames),
    )
    const subAgentDependencies = {
      configs: options.runtimeConfig.subAgents,
      selectedModel,
      rootModel: model,
      reasoning: options.reasoning,
      adapter,
      toolRegistry: this.toolRegistry,
      approvalTools,
      store: this.store,
      runId: options.runId,
      threadId,
      eventSink,
      coordinator,
      ...(this.runtimeOptions.agentTracing ? { agentTracing: this.runtimeOptions.agentTracing } : {}),
    }
    const subAgentState = new SubAgentStateController(subAgentDependencies)
    await subAgentState.initialize(options.runtimeConfig.subAgents)
    const subAgentTools = await createSubAgentTools({
      ...subAgentDependencies,
      stateController: subAgentState,
    })
    const parallelSubAgentTool = createParallelSubAgentTool({
      ...subAgentDependencies,
      maxParallelSubAgents: options.runtimeConfig.maxParallelSubAgents,
      signal,
      stateController: subAgentState,
    })
    const handoffIntegration = createHandoffAgents({
      ...subAgentDependencies,
      stateController: subAgentState,
    })
    const sandboxIntegration = buildRuntimeSdkSandboxIntegration(options.runtimeConfig)
    const sdkExtensionCapabilities = sandboxIntegration.capabilities
    const artifactDirectory = await prepareRunArtifactDirectory(this.store.runtimeRoot, options.runId)
    const sandboxManifest = buildSandboxManifest(options, threadId, sandboxIntegration.pathGrants, {
      artifactDirectory,
    })
    const createSandboxSession = this.runtimeOptions.createSandboxSession ?? createConfiguredSandboxSession
    let sandboxSession: SandboxSessionLike | null = null
    let sdkIntegration: RuntimeSdkIntegration | null = null
    try {
      sandboxSession = await createSandboxSession(sandboxManifest, options.runtimeConfig.sandbox)
      const reservedToolNames = new Set([
        ...this.toolRegistry.list().map(tool => tool.name),
        ...subAgentTools.map(tool => tool.name),
        ...(parallelSubAgentTool ? [PARALLEL_SUBAGENT_TOOL_NAME] : []),
        ...handoffIntegration.handoffs.map(item => item.toolName),
      ])
      sdkIntegration = await createRuntimeSdkIntegration(options.runtimeConfig, reservedToolNames)
    } catch (error) {
      await sdkIntegration?.close().catch(closeError => {
        logger.warn({ error: errorLogPayload(closeError) }, 'sdk mcp close after assembly failure failed')
      })
      await sandboxSession?.close?.().catch(closeError => {
        logger.warn({ error: errorLogPayload(closeError) }, 'sandbox close after assembly failure failed')
      })
      throw error
    }
    if (!sandboxSession || !sdkIntegration) throw new Error('Agents SDK 运行时装配未完成')
    await this.store.updateRunState(options.runId, {
      activeSkills: sandboxIntegration.activeSkills,
      activeMcpServers: sdkIntegration.activeMcpServers,
    })
    if (sandboxIntegration.activeSkills.length || sdkIntegration.activeMcpServers.length) {
      eventSink.emit('step.started', 'SDK 扩展已装配', {
        active_skills: sandboxIntegration.activeSkills,
        active_mcp_servers: sdkIntegration.activeMcpServers,
      })
    }
    const explicitTools = [
      ...supervisorTools,
      ...subAgentTools,
      ...(parallelSubAgentTool ? [parallelSubAgentTool] : []),
      ...sdkIntegration.tools,
    ]
    const agent = new SandboxAgent<AgentsExecutionContext, typeof supervisorDeliverySchema>({
      name: options.runtimeConfig.supervisor.name,
      instructions: () => buildSupervisorInstructions(),
      model,
      modelSettings: modelSettings(options.reasoning),
      resetToolChoice: true,
      tools: visibleExplicitTools(explicitTools, coordinator.isSdkExtensionEnabled()),
      mcpServers: sdkIntegration.mcpServers,
      mcpConfig: sdkIntegration.mcpConfig,
      toolUseBehavior: { stopAtToolNames: returnDirectToolNames },
      outputType: supervisorDeliverySchema,
      handoffs: handoffIntegration.handoffs,
      outputGuardrails: [createPlanModeTerminalGuardrail({
        hasTerminalViolation: () => {
          const state = this.store.getRun(options.runId).state
          const pendingClarification = state.clarification !== null
            && !state.clarification.selectedOptionId
          return coordinator.enteredPlanModeDuringRun()
            && state.planMode
            && !pendingClarification
            && state.agentWorkflow === null
        },
      })],
      defaultManifest: sandboxManifest,
      capabilities: [
        ...coreSandboxCapabilities,
        ...sdkExtensionCapabilities,
      ],
    })
    const unavailableSdkToolCallIds = new Set<string>()
    const runner = new Runner({
      model,
      tracingDisabled: !this.runtimeOptions.agentTracing,
      traceIncludeSensitiveData: false,
      workflowName: 'GeoForge Agent Workflow',
      groupId: threadId,
      traceMetadata: {
        runId: options.runId,
        threadId,
        sessionId: options.sessionId,
        provider: options.provider,
      },
      // Agents SDK 原生地把模型臆造的未知工具转回模型，而不是让协议错误覆盖
      // 已经落盘的业务失败。格式化器同时重申结构化工作流的调整边界。
      toolNotFoundBehavior: 'return_error_to_model',
      toolErrorFormatter: ({ kind, toolName, callId }) => {
        if (kind !== 'tool_not_found') return undefined
        unavailableSdkToolCallIds.add(callId)
        return coordinator.formatUnavailableToolForModel(toolName)
      },
      toolExecution: {
        maxFunctionToolConcurrency: options.runtimeConfig.maxFunctionToolConcurrency,
        preApprovalInputGuardrails: true,
      },
    })
    runner.on('agent_start', (_context, startedAgent) => {
      eventSink.emit('step.started', `Agent：${startedAgent.name}`, {
        agentId: startedAgent.name,
        lifecycle: 'agent_start',
      })
    })
    runner.on('agent_end', (_context, endedAgent) => {
      eventSink.emit('step.completed', `Agent：${endedAgent.name}`, {
        agentId: endedAgent.name,
        lifecycle: 'agent_end',
      })
    })
    runner.on('agent_handoff', (_context, fromAgent, toAgent) => {
      eventSink.emit('subagent.updated', `${fromAgent.name} 已转交给 ${toAgent.name}`, {
        fromAgentId: fromAgent.name,
        agentId: toAgent.name,
        status: 'running',
        delegationMode: 'handoff',
      })
    })

    let assembly: RuntimeAssembly | null = null
    let pendingSessionAssistantContent: string | null = null
    const flushPendingSessionAssistantMessage = async (): Promise<void> => {
      if (!pendingSessionAssistantContent) return
      if (!assembly) throw new Error('SDK Session assistant 消息早于运行时装配完成')
      const content = pendingSessionAssistantContent
      pendingSessionAssistantContent = null
      await this.transcriptProjector.appendAssistantMessageTranscript(assembly, content)
    }
    const discardPendingSessionAssistantMessage = (): void => {
      pendingSessionAssistantContent = null
    }
    const projectSessionItems = async (items: AgentInputItem[]): Promise<void> => {
      if (!assembly) throw new Error('SDK Session item 早于运行时装配完成')
      const currentAssembly = assembly
      for (const item of items) {
        if (isAssistantMessage(item)) {
          const content = assistantText(item)
          if (!content) continue
          await flushPendingSessionAssistantMessage()
          pendingSessionAssistantContent = content
          continue
        }
        if (item.type === 'reasoning' || ('role' in item && item.role === 'user')) continue
        if (item.type === 'function_call') {
          const exists = (await this.store.activeTranscript(threadId))
            .some(entry => entry.kind === 'tool_call' && entry.payload.callId === item.callId)
          if (!exists) {
            if (unavailableSdkToolCallIds.has(item.callId)) {
              const label = currentAssembly.subAgentToolNames.has(item.name)
                ? '子智能体任务'
                : this.toolRegistry.get(item.name)?.label ?? item.name
              await this.transcriptProjector.appendSdkRejectedToolCallTranscript(
                options.runId,
                threadId,
                turnId,
                item,
                itemSink,
                label,
              )
            } else if (this.transcriptProjector.isPlatformManagedTool(item.name, currentAssembly)) {
              throw new Error(`SDK Session 收到未准备的工具调用 '${item.callId}'`)
            } else {
              await this.transcriptProjector.appendSdkNativeToolCallTranscript(
                options.runId,
                threadId,
                turnId,
                item,
                itemSink,
                sdkNativeToolPresentation(item.name, currentAssembly),
              )
            }
          }
          if (pendingSessionAssistantContent) {
            if (!assembly) throw new Error('SDK Session 工具调用早于运行时装配完成')
            await this.transcriptProjector.appendAssistantContentCheckpoint(assembly, item.callId, pendingSessionAssistantContent)
            pendingSessionAssistantContent = null
          }
          continue
        }
        await flushPendingSessionAssistantMessage()
        if (item.type === 'function_call_result') {
          const transcript = await this.store.activeTranscript(threadId)
          const exists = transcript
            .some(entry => entry.kind === 'tool_result' && entry.payload.callId === item.callId)
          if (exists) continue
          const content = toolResultText(item.output)
          const isSubAgent = currentAssembly.subAgentToolNames.has(item.name)
          const isSdkRejectedTool = unavailableSdkToolCallIds.has(item.callId)
          const isSdkNativeTool = !isSdkRejectedTool
            && !this.transcriptProjector.isPlatformManagedTool(item.name, currentAssembly)
          const nativePresentation = sdkNativeToolPresentation(item.name, currentAssembly)
          const platformTool = this.toolRegistry.get(item.name)
          const failedCheckpoint = transcript.some(entry => (
            entry.kind === 'checkpoint'
            && entry.payload.callId === item.callId
            && entry.payload.ledgerStatus === 'failed'
          ))
          const ledgerStatus = isSdkRejectedTool
            ? 'rejected'
            : isSdkNativeTool
            ? sdkNativeLedgerStatus(item.status)
            : (isSubAgent ? 'completed' : failedCheckpoint ? 'failed' : 'rejected')
          await this.store.appendTranscript({
            threadId,
            runId: options.runId,
            turnId,
            kind: 'tool_result',
            payload: {
              callId: item.callId,
              name: item.name,
              label: isSubAgent
                ? '子智能体任务'
                : isSdkRejectedTool
                  ? platformTool?.label ?? item.name
                  : isSdkNativeTool ? nativePresentation.label : platformTool?.label ?? item.name,
              summary: content,
              content,
              contentRef: null,
              ledgerStatus,
              resultId: null,
              ...(isSdkRejectedTool
                ? { source: 'openai_agents_sdk' }
                : isSdkNativeTool ? { source: nativePresentation.source } : {}),
            },
          })
          if (isSdkNativeTool) {
            const outputItem = itemSink.startItem('function_call_output', {
              callId: item.callId,
              name: item.name,
              role: 'tool',
              metadata: { toolLabel: nativePresentation.label, source: nativePresentation.source },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: item.callId,
              name: item.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: { toolLabel: nativePresentation.label, source: nativePresentation.source },
            })
          }
          await this.store.saveRunCheckpoint(options.runId, {
            pendingToolCallIds: [],
            recoveryStatus: 'clean',
          })
          unavailableSdkToolCallIds.delete(item.callId)
        }
      }
    }
    const history = conversationMessagesToAgentItems(assembled.messages, options.query, systemPrompt)
    const session = new FileAgentsSession(
      `${options.sessionId}:${threadId}`,
      history,
      projectSessionItems,
    )
    assembly = {
      agent,
      runner,
      session,
      context,
      coordinator,
      adapter,
      sandboxSession,
      sdkIntegration,
      configDigest: runtimeConfigDigest(options.runtimeConfig),
      sdkVersion: await agentsSdkVersion(),
      threadId,
      turnId,
      subAgentToolNames: new Set([
        ...options.runtimeConfig.subAgents
          .filter(config => config.delegationMode === 'as_tool')
          .map(config => config.agentId),
        ...(parallelSubAgentTool ? [PARALLEL_SUBAGENT_TOOL_NAME] : []),
      ]),
      handoffToolNames: new Set(handoffIntegration.handoffs.map(item => item.toolName)),
      handoffAgentNames: handoffIntegration.agentIds,
      mcpToolNames: sdkIntegration.mcpToolNames,
      completeHandoff: handoffIntegration.complete,
      failHandoff: handoffIntegration.fail,
      flushPendingSessionAssistantMessage,
      discardPendingSessionAssistantMessage,
    }
    return assembly
  }

  private async executeSdkRun(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext, typeof supervisorDeliverySchema>> | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<'completed' | 'waiting_approval' | 'clarification_needed'> {
    let outcome: 'completed' | 'waiting_approval' | 'clarification_needed' | null = null
    let nextInput: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext, typeof supervisorDeliverySchema>> | AgentInputItem[] | string = resumeState ?? options.query
    let activeProjection: StreamProjectionState | null = null
    try {
      while (true) {
        const projection = this.transcriptProjector.createState()
        activeProjection = projection
        const stream = await assembly.runner.run(
          assembly.agent,
          nextInput,
          {
            stream: true,
            context: new RunContext(assembly.context),
            session: assembly.session,
            sandbox: { session: assembly.sandboxSession },
            maxTurns: options.runtimeConfig.maxTurns,
            signal,
            callModelInputFilter: async ({ modelData }) => {
              const steeringItems = await this.steering.consumePending(options.runId)
              if (!steeringItems.length) return modelData
              return { ...modelData, input: [...modelData.input, ...steeringItems] }
            },
          },
        )
        await this.checkpoints.persist(options.runId, stream.state, assembly)
        for await (const event of stream) {
          await this.transcriptProjector.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
          if (event.type === 'run_item_stream_event' && ['tool_output', 'tool_approval_requested'].includes(event.name)) {
            await this.checkpoints.persist(options.runId, stream.state, assembly)
          }
        }
        await stream.completed
        if (stream.error) throw stream.error
        await this.transcriptProjector.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
        if (projection.reasoningItemId) {
          itemSink.completeItem(projection.reasoningItemId, { body: projection.reasoningText })
        }
        await this.updateUsage(options.runId, stream.rawResponses)
        const interruptions = stream.interruptions
        if (interruptions.length) {
          await this.checkpoints.persist(options.runId, stream.state, assembly)
          await this.approvalPersistence.persist(options, interruptions, eventSink, itemSink)
          await eventSink.flush()
          await itemSink.flush()
          outcome = 'waiting_approval'
          return outcome
        }
        assembly.discardPendingSessionAssistantMessage()
        const runAfterTools = this.store.getRun(options.runId)
        if (runAfterTools.state.clarification && !runAfterTools.state.clarification.selectedOptionId) {
          eventSink.emit('clarification.required', runAfterTools.state.clarification.question, {
            clarification: runAfterTools.state.clarification,
          })
          itemSink.appendResult('clarification_needed', {
            decisionId: runAfterTools.state.clarification.clarificationId,
            clarification: runAfterTools.state.clarification,
            message: runAfterTools.state.clarification.question,
          })
          await this.checkpoints.persist(options.runId, stream.state, assembly)
          await this.store.saveRunCheckpoint(options.runId, {
            pendingToolCallIds: [],
            recoveryStatus: 'clean',
          })
          await eventSink.flush()
          await itemSink.flush()
          await this.store.completeRun(options.runId, 'clarification_needed')
          outcome = 'clarification_needed'
          return outcome
        }
        const agentWorkflow = this.store.getRun(options.runId).state.agentWorkflow
        if (agentWorkflow && agentWorkflow.status !== 'completed') {
          throw new Error(`智能体工作流尚未完成，当前状态为 ${agentWorkflow.status}。必须完成或显式调整剩余步骤后再交付最终回答。`)
        }
        const incompleteTodos = this.store.getRun(options.runId).state.todos
          .filter(todo => todo.status === 'pending' || todo.status === 'running')
        if (incompleteTodos.length) {
          throw new Error(`运行仍有未完成 Todo：${incompleteTodos.map(todo => todo.title).join('、')}。请先更新为完成、失败或受阻状态。`)
        }
        const delivery = parseSupervisorDelivery(stream.finalOutput)
        const finalOutput = delivery.markdown.trim()
        assertDeliveryArtifacts(runAfterTools, delivery)
        const lastAgentName = stream.lastAgent?.name
        if (lastAgentName && assembly.handoffAgentNames.has(lastAgentName)) {
          await assembly.completeHandoff(lastAgentName, delivery.summary)
        }
        const item = itemSink.startItem('message', { role: 'assistant' })
        const persisted = await this.transcriptProjector.appendAssistantMessageTranscript(assembly, finalOutput, item.itemId)
        itemSink.completeItem(item.itemId, {
          body: finalOutput,
          metadata: {
            transcriptEntryId: persisted.entryId,
            deliverySummary: delivery.summary,
            artifactIds: delivery.artifactIds,
            warnings: delivery.warnings,
          },
        })
        await this.checkpoints.persist(options.runId, stream.state, assembly)
        await this.store.saveRunCheckpoint(options.runId, {
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
        })
        await eventSink.flush()
        await itemSink.flush()

        if (await this.steering.tryClose(options.runId)) {
          outcome = 'completed'
          return outcome
        }
        // 新消息在本轮最终回答生成期间到达。沿用同一 SDK Session 开启下一轮，
        // 消息仍由 callModelInputFilter 在下一次模型调用前原子消费。
        nextInput = []
      }
    } catch (error) {
      const activeHandoff = assembly.coordinator.activeHandoffAgent()
      if (activeHandoff) {
        await assembly.failHandoff(activeHandoff, errorMessage(error)).catch(handoffError => {
          logger.warn({ error: errorLogPayload(handoffError) }, 'handoff failure state update failed')
        })
      }
      if (activeProjection) {
        this.transcriptProjector.failPendingSubAgentItems(activeProjection, itemSink, errorMessage(error))
      }
      throw error
    } finally {
      await assembly.sdkIntegration.close().catch(error => {
        logger.warn({ error: errorLogPayload(error) }, 'sdk mcp close failed')
      })
      if (outcome !== 'waiting_approval') {
        await assembly.sandboxSession.close?.().catch(error => {
          logger.warn({ error: errorLogPayload(error) }, 'sandbox close failed')
        })
      }
    }
  }

  private async updateUsage(runId: string, responses: Array<{ usage: ModelUsageLike }>): Promise<void> {
    if (!responses.length) return
    const usage = aggregateModelUsage(responses)
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, {
      runtimeStats: mergeModelUsageStats(run.state.runtimeStats, usage),
    })
  }

  private async maybeExtractLongTermMemories(options: RunOptions, threadId: string, eventSink: RunEventSink): Promise<void> {
    const config = options.runtimeConfig.context
    if (!config.memoryEnabled || !config.memoryAutoExtractEnabled) return
    if (!this.memoryToolsAvailable()) return
    try {
      const selector = this.makeStructuredSelector(options)
      const runtimeMemory = createMemoryRuntime(this.store.runtimeRoot, config)
      await extractMemoriesFromThread(
        runtimeMemory,
        this.store,
        threadId,
        options.runId,
        selector,
      )
      if (config.memoryAutoDreamEnabled) {
        await dreamMemories(runtimeMemory, selector)
      }
    } catch (error) {
      await this.recordWarning(options.runId, `长期记忆自动提取失败：${errorMessage(error)}`, eventSink)
    }
  }

  private makeStructuredSelector(options: RunOptions): (prompt: string) => Promise<Record<string, unknown>> {
    const adapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
    const model = options.runtimeConfig.context.summaryModel
      ?? adapter.subagentModel
      ?? options.modelName
      ?? adapter.defaultModel
    if (!model) throw new Error('未配置记忆选择模型')
    return async (prompt: string) => {
      const workspaceId = this.store.getRun(options.runId).workspaceId
      if (this.modelCompletions && workspaceId) {
        const response = await this.modelCompletions.completeJson({
          workspaceId,
          runId: options.runId,
          provider: adapter.provider,
          model,
          purpose: 'memory_selection',
          prompt,
        })
        await recordModelCompletionUsage(this.store, options.runId, response)
        return response.content
      }
      const response = await adapter.chat(prompt, { model, reasoning: false })
      const content = response.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('记忆选择模型未返回文本')
      return parseStructuredJson(content)
    }
  }

  private async recordWarning(runId: string, message: string, eventSink: RunEventSink): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, { warnings: [...run.state.warnings, message] })
    eventSink.emit('warning.raised', message, {})
  }

  private memoryToolsAvailable(): boolean {
    return Boolean(this.toolRegistry.get('list_memories')
      && this.toolRegistry.get('search_memory')
      && this.toolRegistry.get('read_memory')
      && this.toolRegistry.get('write_memory')
      && this.toolRegistry.get('forget_memory'))
  }
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abortTarget = () => target.abort(source.reason)
  if (source.aborted) {
    abortTarget()
    return () => {}
  }
  source.addEventListener('abort', abortTarget, { once: true })
  return () => source.removeEventListener('abort', abortTarget)
}

function assertAgentRuntimeCapabilities(adapter: ModelAdapter, config: AgentRuntimeConfig): void {
  const capabilities = adapter.agentRuntimeCapabilities
  if (capabilities.structuredOutput === 'none') {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 Agent 结构化输出`)
  }
  if (!capabilities.functionTools) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 Agent function tools`)
  }
  const enabledMcp = config.sdk.mcp.enabled
    ? config.sdk.mcp.servers.filter(server => server.enabled)
    : []
  if (enabledMcp.some(server => server.executionMode === 'function_tools') && !capabilities.localMcp) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持本地 MCP 工具`)
  }
  if (enabledMcp.some(server => server.executionMode === 'hosted') && !capabilities.hostedTools) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 Hosted MCP`)
  }
  if (config.subAgents.some(agent => agent.delegationMode === 'handoff') && !capabilities.handoffs) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 Agent handoff`)
  }
}

function parseSupervisorDelivery(
  finalOutput: unknown,
): SupervisorDelivery {
  const parsed = supervisorDeliverySchema.safeParse(finalOutput)
  if (parsed.success) return parsed.data
  throw new Error('Agent 最终输出不符合结构化交付契约')
}

function assertDeliveryArtifacts(run: AnalysisRun, delivery: SupervisorDelivery): void {
  if (!delivery.artifactIds.length) return
  const owned = new Set(run.state.artifacts.map(artifact => artifact.artifactId))
  const missing = [...new Set(delivery.artifactIds)].filter(artifactId => !owned.has(artifactId))
  if (missing.length) {
    throw new Error(`Agent 最终输出引用了当前运行不存在的 Artifact：${missing.join('、')}`)
  }
}

function visibleExplicitTools(
  tools: Tool<AgentsExecutionContext>[],
  sdkExtensionEnabled: boolean,
): Tool<AgentsExecutionContext>[] {
  if (sdkExtensionEnabled) return tools
  // Hosted MCP 不是 function tool，Agents SDK 不会对它应用 isEnabled；规划阶段
  // 和结构化工作流执行期间都必须从 Agent 的公开工具列表中移除。
  return tools.filter(tool => tool.type !== 'hosted_tool')
}

function sdkNativeToolPresentation(
  toolName: string,
  assembly: RuntimeAssembly,
): { label: string; source: string } {
  if (assembly.handoffToolNames.has(toolName)) {
    return { label: 'Handoff 转交', source: 'openai_agents_handoff' }
  }
  if (assembly.mcpToolNames.has(toolName)) {
    return { label: 'MCP 工具调用', source: 'openai_agents_mcp' }
  }
  return { label: '沙箱工具调用', source: 'openai_agents_sandbox' }
}

function wrapReturnDirectTools(
  tools: Tool<AgentsExecutionContext>[],
  returnDirectToolNames: ReadonlySet<string>,
): Tool<AgentsExecutionContext>[] {
  return tools.map(tool => {
    if (tool.type !== 'function' || !returnDirectToolNames.has(tool.name)) return tool
    const invoke = tool.invoke.bind(tool)
    return {
      ...tool,
      invoke: async (runContext, input, details) => {
        const output = await invoke(runContext, input, details)
        if (typeof output !== 'string') {
          throw new Error(`直接交付工具 '${tool.name}' 返回了非文本结果`)
        }
        const markdown = output.trim()
        return JSON.stringify({ markdown, summary: markdown, artifactIds: [], warnings: [] })
      },
    }
  })
}

function planAwareSandboxCapabilities(): Capability[] {
  return [
    filesystem({
      configureTools: tools => gateSandboxTools(tools, new Set(['view_image'])),
    }),
    shell({
      configureTools: tools => gateSandboxTools(tools, new Set()),
    }),
    compaction(),
  ]
}

function gateSandboxTools<TContext>(
  tools: Tool<TContext>[],
  planModeDiscoveryTools: ReadonlySet<string>,
): Tool<TContext>[] {
  return tools.map(tool => {
    if (tool.type !== 'function') return tool
    const isEnabled: typeof tool.isEnabled = async (runContext, agent) => {
      const context = runContext.context as unknown as Partial<AgentsExecutionContext>
      const executionEnabled = typeof context.isExecutionEnabled === 'function'
        && context.isExecutionEnabled()
      const sdkExtensionEnabled = typeof context.isSdkExtensionEnabled === 'function'
        && context.isSdkExtensionEnabled()
      const planningDiscovery = !executionEnabled && planModeDiscoveryTools.has(tool.name)
      if (!sdkExtensionEnabled && !planningDiscovery) return false
      return tool.isEnabled(runContext, agent)
    }
    const invoke: typeof tool.invoke = async (runContext, input, details) => {
      const context = runContext.context as unknown as Partial<AgentsExecutionContext>
      const executionEnabled = typeof context.isExecutionEnabled === 'function'
        && context.isExecutionEnabled()
      const sdkExtensionEnabled = typeof context.isSdkExtensionEnabled === 'function'
        && context.isSdkExtensionEnabled()
      const planningDiscovery = !executionEnabled && planModeDiscoveryTools.has(tool.name)
      if (!sdkExtensionEnabled && !planningDiscovery) {
        throw new Error(`当前规划或结构化工作流边界禁止调用沙箱工具 '${tool.name}'。`)
      }
      return tool.invoke(runContext, input, details)
    }
    return { ...tool, isEnabled, invoke }
  })
}
