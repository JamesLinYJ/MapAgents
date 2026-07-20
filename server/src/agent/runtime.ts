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
import type { ModelAdapterRegistry } from '../model/registry.js'
import type {
  AnalysisRun,
  ToolValueRef,
} from '../schemas/types.js'
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
  type OpenAIAgentsRuntimeOptions,
} from './runtimeSandbox.js'
import {
  buildRuntimeSdkSandboxIntegration,
  createRuntimeSdkTools,
  type RuntimeSdkToolIntegration,
} from './runtimeSdkIntegrations.js'
import { aggregateModelUsage, mergeModelUsageStats, type ModelUsageLike } from './modelUsage.js'
import { AgentsCheckpointService } from './agentsCheckpointService.js'
import { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import { RunSteeringController } from './runSteeringController.js'
import type { RunOptions, RuntimeAssembly, StreamProjectionState } from './runtimeTypes.js'
import { createSubAgentTools } from './subAgentToolFactory.js'

export type { OpenAIAgentsRuntimeOptions, SandboxSessionFactory } from './runtimeSandbox.js'
export type { RunOptions } from './runtimeTypes.js'

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

    try {
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
      const message = errorMessage(error)
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
      await this.steering.close(options.runId)
      unlinkExternalAbort()
      this.abortControllers.delete(options.runId)
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
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
    try {
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
      const message = errorMessage(error)
      if (abort.signal.aborted) {
        await finalizer.cancel()
      } else {
        const current = this.store.getRun(runId)
        await this.store.updateRunState(runId, { errors: [...current.state.errors, message] })
        await finalizer.fail(message)
      }
      return this.store.getRun(runId)
    } finally {
      await this.steering.close(runId)
      unlinkExternalAbort()
      this.abortControllers.delete(runId)
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
    if (!adapter.createAgentModel) throw new Error(`模型 provider '${adapter.provider}' 不支持 Agents SDK Supervisor`)
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
    let supervisorAgent: Agent<AgentsExecutionContext> | null = null
    let explicitTools: Tool<AgentsExecutionContext>[] = []
    let sdkExtensionCapabilities: Capability[] = []
    const coreSandboxCapabilities = planAwareSandboxCapabilities()
    const applyPlanModeModelBoundary = (): void => {
      if (!supervisorAgent) return
      supervisorAgent.instructions = buildSupervisorInstructions()
      supervisorAgent.modelSettings = modelSettings(options.reasoning)
      supervisorAgent.resetToolChoice = true
      supervisorAgent.tools = visibleExplicitTools(explicitTools, coordinator.isSdkExtensionEnabled())
      if (supervisorAgent instanceof SandboxAgent) {
        supervisorAgent.capabilities = [
          ...coreSandboxCapabilities,
          ...(coordinator.isSdkExtensionEnabled() ? sdkExtensionCapabilities : []),
        ]
      }
    }
    const context: AgentsExecutionContext = {
      runId: options.runId,
      isExecutionEnabled: () => coordinator.isExecutionEnabled(),
      isSdkExtensionEnabled: () => coordinator.isSdkExtensionEnabled(),
      isToolEnabled: toolName => coordinator.isToolEnabled(toolName),
      validateToolCall: (toolName, args) => coordinator.validateToolCall(toolName, args),
      rejectPreparedToolCall: (toolName, callId, message) => coordinator.rejectPreparedToolCall(toolName, callId, message),
      prepareToolCall: (toolName, args, callId) => coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => coordinator.executeForModel(toolName, args, callId),
    }
    coordinator = new ToolExecutionCoordinator({
      store: this.store,
      registry: this.toolRegistry,
      adapter,
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
      onPlanModeChanged: applyPlanModeModelBoundary,
    })
    const approvalTools = new Set(options.runtimeConfig.supervisor.approvalInterruptTools)
    const supervisorTools = createAgentsTools(this.toolRegistry, approvalTools, {
      schemaMode: adapter.agentToolSchemaMode,
    })
    const returnDirectToolNames = this.toolRegistry.list()
      .filter(tool => (tool.executionSurfaces?.includes('agent') ?? true) && tool.agentResultMode === 'return_direct')
      .map(tool => tool.name)
    const subAgentTools = await createSubAgentTools({
      configs: options.runtimeConfig.subAgents,
      selectedModel,
      rootModel: model,
      reasoning: options.reasoning,
      adapter,
      toolRegistry: this.toolRegistry,
      approvalTools,
      store: this.store,
      runId: options.runId,
      eventSink,
      coordinator,
    })
    const sandboxIntegration = buildRuntimeSdkSandboxIntegration(options.runtimeConfig)
    sdkExtensionCapabilities = sandboxIntegration.capabilities
    const artifactDirectory = await prepareRunArtifactDirectory(this.store.runtimeRoot, options.runId)
    const sandboxManifest = buildSandboxManifest(options, threadId, sandboxIntegration.pathGrants, {
      artifactDirectory,
    })
    const createSandboxSession = this.runtimeOptions.createSandboxSession ?? createConfiguredSandboxSession
    let sandboxSession: SandboxSessionLike | null = null
    let sdkTools: RuntimeSdkToolIntegration | null = null
    try {
      sandboxSession = await createSandboxSession(sandboxManifest, options.runtimeConfig.sandbox)
      const reservedToolNames = new Set([
        ...this.toolRegistry.list().map(tool => tool.name),
        ...options.runtimeConfig.subAgents.map(config => config.agentId),
      ])
      sdkTools = await createRuntimeSdkTools(options.runtimeConfig, reservedToolNames)
    } catch (error) {
      await sdkTools?.close().catch(closeError => {
        logger.warn({ error: errorLogPayload(closeError) }, 'sdk mcp close after assembly failure failed')
      })
      await sandboxSession?.close?.().catch(closeError => {
        logger.warn({ error: errorLogPayload(closeError) }, 'sandbox close after assembly failure failed')
      })
      throw error
    }
    if (!sandboxSession || !sdkTools) throw new Error('Agents SDK 运行时装配未完成')
    await this.store.updateRunState(options.runId, {
      activeSkills: sandboxIntegration.activeSkills,
      activeMcpServers: sdkTools.activeMcpServers,
    })
    if (sandboxIntegration.activeSkills.length || sdkTools.activeMcpServers.length) {
      eventSink.emit('step.started', 'SDK 扩展已装配', {
        active_skills: sandboxIntegration.activeSkills,
        active_mcp_servers: sdkTools.activeMcpServers,
      })
    }
    explicitTools = [...supervisorTools, ...subAgentTools, ...sdkTools.tools]
    const agent = new SandboxAgent<AgentsExecutionContext>({
      name: options.runtimeConfig.supervisor.name,
      instructions: systemPrompt,
      model,
      modelSettings: modelSettings(options.reasoning),
      resetToolChoice: true,
      tools: visibleExplicitTools(explicitTools, coordinator.isSdkExtensionEnabled()),
      toolUseBehavior: { stopAtToolNames: returnDirectToolNames },
      defaultManifest: sandboxManifest,
      capabilities: [
        ...coreSandboxCapabilities,
        ...(coordinator.isSdkExtensionEnabled() ? sdkExtensionCapabilities : []),
      ],
    })
    supervisorAgent = agent
    const runner = new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolNotFoundBehavior: 'raise_error',
      toolExecution: {
        maxFunctionToolConcurrency: options.runtimeConfig.maxFunctionToolConcurrency,
        preApprovalInputGuardrails: true,
      },
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
    const projectSessionItems = async (items: AgentInputItem[]): Promise<void> => {
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
            if (this.transcriptProjector.isPlatformManagedTool(item.name, options.runtimeConfig)) {
              throw new Error(`SDK Session 收到未准备的工具调用 '${item.callId}'`)
            }
            await this.transcriptProjector.appendSandboxNativeToolCallTranscript(options.runId, threadId, turnId, item, itemSink)
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
          const isSubAgent = options.runtimeConfig.subAgents.some(config => config.agentId === item.name)
          const isSandboxNativeTool = !this.transcriptProjector.isPlatformManagedTool(item.name, options.runtimeConfig)
          const platformTool = this.toolRegistry.get(item.name)
          const failedCheckpoint = transcript.some(entry => (
            entry.kind === 'checkpoint'
            && entry.payload.callId === item.callId
            && entry.payload.ledgerStatus === 'failed'
          ))
          const ledgerStatus = isSandboxNativeTool
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
              label: isSubAgent ? '子智能体任务' : isSandboxNativeTool ? '沙箱工具调用' : platformTool?.label ?? item.name,
              summary: content,
              content,
              contentRef: null,
              ledgerStatus,
              resultId: null,
              ...(isSandboxNativeTool ? { source: 'openai_agents_sandbox' } : {}),
            },
          })
          if (isSandboxNativeTool) {
            const outputItem = itemSink.startItem('function_call_output', {
              callId: item.callId,
              name: item.name,
              role: 'tool',
              metadata: { toolLabel: '沙箱工具调用', source: 'openai_agents_sandbox' },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: item.callId,
              name: item.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: { toolLabel: '沙箱工具调用', source: 'openai_agents_sandbox' },
            })
          }
          await this.store.saveRunCheckpoint(options.runId, {
            pendingToolCallIds: [],
            recoveryStatus: 'clean',
          })
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
      sdkTools,
      configDigest: runtimeConfigDigest(options.runtimeConfig),
      sdkVersion: await agentsSdkVersion(),
      threadId,
      turnId,
      subAgentNames: new Set(options.runtimeConfig.subAgents.map(config => config.agentId)),
      flushPendingSessionAssistantMessage,
    }
    return assembly
  }

  private async executeSdkRun(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>> | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<'completed' | 'waiting_approval' | 'clarification_needed'> {
    let outcome: 'completed' | 'waiting_approval' | 'clarification_needed' | null = null
    let nextInput: RunState<AgentsExecutionContext, Agent<AgentsExecutionContext>> | AgentInputItem[] | string = resumeState ?? options.query
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
        await assembly.flushPendingSessionAssistantMessage()
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
        const finalOutput = typeof stream.finalOutput === 'string' ? stream.finalOutput.trim() : ''
        if (!finalOutput) throw new Error('Agent 未返回可交付文本')
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
        if (!projection.lastAssistantText || projection.lastAssistantText !== finalOutput) {
          const synthetic: AgentInputItem = {
            type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: finalOutput }],
          }
          const content = assistantText(synthetic)
          if (!content) throw new Error('终止工具未生成可持久化文本')
          const item = itemSink.startItem('message', { role: 'assistant' })
          const persisted = await this.transcriptProjector.appendAssistantMessageTranscript(assembly, content, item.itemId)
          itemSink.completeItem(item.itemId, {
            body: finalOutput,
            metadata: { transcriptEntryId: persisted.entryId },
          })
        }
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
      if (activeProjection) {
        this.transcriptProjector.failPendingSubAgentItems(activeProjection, itemSink, errorMessage(error))
      }
      throw error
    } finally {
      await assembly.sdkTools.close().catch(error => {
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

function visibleExplicitTools(
  tools: Tool<AgentsExecutionContext>[],
  sdkExtensionEnabled: boolean,
): Tool<AgentsExecutionContext>[] {
  if (sdkExtensionEnabled) return tools
  // Hosted MCP 不是 function tool，Agents SDK 不会对它应用 isEnabled；规划阶段
  // 和结构化工作流执行期间都必须从 Agent 的公开工具列表中移除。
  return tools.filter(tool => tool.type !== 'hosted_tool')
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
