// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行时装配
//
//   文件:       runtimeAssembly.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  Agent,
  Runner,
  webSearchTool,
  type AgentOptions,
  type AgentInputItem,
  type ModelRequest,
  type Tool,
} from '@openai/agents'
import {
  SandboxAgent,
  filesystem,
  shell,
  type Capability,
} from '@openai/agents/sandbox'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import type { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import { buildMemoryPrompt, createMemoryRuntime, rebuildSessionMemory } from '../memory/service.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import {
  resolveAdapterModelCapabilities,
  type ModelAdapter,
  type ModelAdapterRegistry,
} from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import type {
  AgentRuntimeConfig,
  ModelCapabilitySnapshot,
  ToolValueRef,
} from '../schemas/types.js'
import type { VisibleArtifactResource } from '../store/postgres/artifactRepository.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import {
  assembleThreadContext,
  compactThreadIfNeeded,
} from './contextManager.js'
import { createAgentsTools, type AgentsExecutionContext } from './agentsToolBridge.js'
import {
  agentsSdkVersion,
  assertAgentsSdkVersionSupported,
  runtimeConfigDigest,
} from './agentsRuntimeMetadata.js'
import { FileAgentsSession } from './fileAgentsSession.js'
import { createHandoffAgents } from './handoffAgentFactory.js'
import { buildPlanningCapabilityCatalog, buildSystemPrompt } from './prompts.js'
import { RunToolConcurrencyGate } from './runToolConcurrencyGate.js'
import {
  buildSandboxManifest,
  buildSandboxRunConfig,
  prepareRunArtifactDirectory,
  type SandboxArtifactMount,
  type SandboxClientFactory,
} from './runtimeSandbox.js'
import {
  assistantText,
  conversationMessagesToAgentItems,
  errorMessage,
  isAssistantMessage,
  modelSettings,
  parseArguments,
  sdkNativeLedgerStatus,
  toolResultText,
} from './runtimeSdkProjection.js'
import {
  buildRuntimeSdkSandboxIntegration,
  createRuntimeSdkIntegration,
} from './runtimeSdkIntegrations.js'
import type { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import type { RunOptions, RuntimeAssembly } from './runtimeTypes.js'
import {
  protectModelTransportFromRunInputMarkers,
  RuntimeModelInputController,
  type ToolOutputReference,
} from './runtimeModelInput.js'
import { createSubAgentTools } from './subAgentToolFactory.js'
import { SubAgentStateController } from './subAgentRuntimeSupport.js'
import type { SubAgentControlPlane } from './subAgentControlPlane.js'
import { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import {
  DEVELOPER_TOOL_PROVIDER_ID,
  developerToolsEnabledForRuntime,
} from './toolExecutionPolicy.js'
import type { RunEventSink } from './turnRunner.js'
import { ToolResultCommitService } from '../tools/resultPersistence.js'
import { makeId } from '../utils/ids.js'
import type { AgentStepContextRecorder } from '../agent-runtime/step/AgentStepContextFactory.js'
import {
  createAgentToolPlan,
  handoffToolPlanSource,
  platformToolPlanSource,
  sdkToolPlanSource,
  type AgentToolPlanSource,
} from '../agent-runtime/step/AgentToolPlan.js'

export interface RuntimeAssemblyFactoryOptions {
  createSandboxClient?: SandboxClientFactory
  agentTracing?: LocalAgentTracing
}

interface RuntimeAssemblyFactoryDependencies {
  store: AgentRuntimeStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  transcriptProjector: RuntimeTranscriptProjector
  runtimeOptions: RuntimeAssemblyFactoryOptions
  modelCompletions?: ModelCompletionService
  subAgentControls: SubAgentControlPlane
  stepContexts: AgentStepContextRecorder
  recordWarning: (
    runId: string,
    message: string,
    eventSink: RunEventSink,
  ) => Promise<void>
}

// 将模型、工具、子智能体、Sandbox、MCP 与 Session 装配为单次 Runner 输入。
// 本工厂不执行 Runner，也不拥有平台运行生命周期。
export class RuntimeAssemblyFactory {
  constructor(private readonly dependencies: RuntimeAssemblyFactoryDependencies) {}

  async create(
    options: RunOptions,
    threadId: string,
    turnId: string,
    eventSink: RunEventSink,
    itemSink: ItemSink,
    signal: AbortSignal,
    maintainContext = true,
  ): Promise<RuntimeAssembly> {
    const {
      modelCompletions,
      modelRegistry,
      recordWarning,
      runtimeOptions,
      stepContexts,
      store,
      subAgentControls,
      toolRegistry,
      transcriptProjector,
    } = this.dependencies
    const adapter = modelRegistry.resolveProvider(options.provider)
    const workspaceId = store.getRun(options.runId).workspaceId
    if (!adapter.createAgentModel) {
      throw new Error(`模型 provider '${adapter.provider}' 不支持 Agents SDK Supervisor`)
    }
    const selectedModel = options.modelName ?? adapter.defaultModel
    if (!selectedModel) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
    const sdkVersion = await agentsSdkVersion()
    assertAgentsSdkVersionSupported(sdkVersion)
    const modelCapabilities = resolveAdapterModelCapabilities(adapter, selectedModel)
    assertAgentRuntimeCapabilities(adapter, modelCapabilities, options.runtimeConfig)
    const configDigest = runtimeConfigDigest(options.runtimeConfig)
    const segmentId = makeId('segment')
    const providerModel = adapter.createAgentModel(selectedModel)
    const subAgentRootModel = protectModelTransportFromRunInputMarkers(providerModel)
    let captureModelRequest: ((request: ModelRequest) => Promise<void>) | null = null
    const model = protectModelTransportFromRunInputMarkers(providerModel, request => {
      if (!captureModelRequest) {
        throw new Error('Agent StepContext 记录器尚未绑定模型请求')
      }
      return captureModelRequest(request)
    })
    const developerToolsEnabled = developerToolsEnabledForRuntime(options.runtimeConfig)
    const registeredAgentTools = toolRegistry.list()
      .filter(tool => tool.executionSurfaces?.includes('agent') ?? true)
    const supervisorToolDefinitions = developerToolsEnabled
      ? registeredAgentTools
      : registeredAgentTools.filter(tool => tool.providerId !== DEVELOPER_TOOL_PROVIDER_ID)
    const disabledDeveloperToolNames = developerToolsEnabled
      ? new Set<string>()
      : new Set(registeredAgentTools
          .filter(tool => tool.providerId === DEVELOPER_TOOL_PROVIDER_ID)
          .map(tool => tool.name))
    const subAgentConfigs = options.runtimeConfig.subAgents.map(config => ({
      ...config,
      tools: config.tools.filter(toolName => !disabledDeveloperToolNames.has(toolName)),
    }))
    const contextConfig = {
      ...options.runtimeConfig.context,
      contextWindowTokens: modelCapabilities.contextWindowTokens,
    }
    const summarize = async (prompt: string) => {
      const summaryAdapter = modelRegistry.resolveProvider(
        options.runtimeConfig.context.summaryProvider ?? options.provider,
      )
      const summaryModel = options.runtimeConfig.context.summaryModel
        ?? summaryAdapter.subagentModel
        ?? selectedModel
      if (!summaryModel) throw new Error('未配置摘要模型')
      if (modelCompletions && workspaceId) {
        const response = await modelCompletions.completeText({
          workspaceId,
          runId: options.runId,
          provider: summaryAdapter.provider,
          model: summaryModel,
          purpose: 'thread_summary',
          prompt,
          signal,
        })
        await recordModelCompletionUsage(store, options.runId, response)
        return response.content
      }
      const response = await summaryAdapter.chat(prompt, {
        model: summaryModel,
        reasoning: false,
        signal,
      })
      if (typeof response.content !== 'string' || !response.content.trim()) {
        throw new Error('摘要模型未返回文本')
      }
      return response.content
    }

    if (maintainContext) {
      await compactThreadIfNeeded(store, threadId, contextConfig, summarize)
      try {
        await rebuildSessionMemory(store, threadId, contextConfig, summarize, false, options.runId)
      } catch (error) {
        await recordWarning(options.runId, `会话记忆更新失败：${errorMessage(error)}`, eventSink)
      }
    }

    const run = store.getRun(options.runId)
    const visibleArtifactResources = await store.listArtifactsVisibleToRun(options.runId, { limit: 24 })
    const memoryPrompt = await buildMemoryPrompt(
      createMemoryRuntime(store.runtimeRoot, contextConfig),
      memoryToolsAvailable(toolRegistry),
    )
    const buildSupervisorInstructions = (): string => {
      const currentState = store.getRun(options.runId).state
      const planningCatalog = currentState.planMode
        ? buildPlanningCapabilityCatalog(supervisorToolDefinitions, subAgentConfigs)
        : ''
      return buildSystemPrompt(options.runtimeConfig, currentState, planningCatalog, '', memoryPrompt)
    }
    const systemPrompt = buildSupervisorInstructions()
    const assembled = await assembleThreadContext(
      store,
      threadId,
      contextConfig,
      systemPrompt,
      {
        excludeRunId: options.runId,
        artifactResources: visibleArtifactResources,
      },
    )
    await store.updateRunState(options.runId, {
      runtimeStats: {
        ...run.state.runtimeStats,
        contextEstimatedTokens: assembled.report.estimatedTokens,
        contextUsagePermille: Math.round(assembled.report.usageRatio * 1000),
      },
    })

    const valueState = createThreadValueState(store, threadId, options.runId)
    const executionGate = new RunToolConcurrencyGate()
    let coordinator: ToolExecutionCoordinator
    const sandboxEnabled = options.runtimeConfig.sandbox.backend !== 'disabled'
    const coreSandboxCapabilities = sandboxEnabled
      ? planAwareSandboxCapabilities(executionGate)
      : []
    const context: AgentsExecutionContext = {
      runId: options.runId,
      currentObjectiveRevision: () => coordinator.currentModelInputObjectiveRevision(),
      isExecutionEnabled: () => coordinator.isExecutionEnabled(),
      isSdkExtensionEnabled: () => coordinator.isSdkExtensionEnabled(),
      isToolEnabled: toolName => coordinator.isToolEnabled(toolName),
      validateToolCall: (toolName, args) => coordinator.validateToolCall(toolName, args),
      formatToolFailureForModel: (toolName, message) => coordinator.formatToolFailureForModel(toolName, message),
      rejectPreparedToolCall: (toolName, callId, message) => coordinator.rejectPreparedToolCall(toolName, callId, message),
      prepareToolCall: (toolName, args, callId) => coordinator.prepare(toolName, args, callId),
      executeTool: (toolName, args, callId) => coordinator.executeForModel(toolName, args, callId),
      runToolExecution: (lane, operation) => executionGate.run(lane, operation),
      toolOutputMetadata: callId => coordinator.toolOutputMetadata(callId),
    }
    const recoveryCheckpoint = await store.getRunCheckpoint(options.runId)
    coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry: toolRegistry,
      adapter,
      ...(modelCompletions ? { modelCompletions } : {}),
      workspaceId,
      runId: options.runId,
      sessionId: options.sessionId,
      threadId,
      turnId,
      modelName: selectedModel,
      inlineToolResultMaxChars: options.runtimeConfig.context.inlineToolResultMaxChars,
      runtimeConfig: options.runtimeConfig,
      subAgentConfigs,
      auth: options.auth ?? null,
      eventSink,
      itemSink,
      valueState,
      signal,
      initialPendingToolCallIds: recoveryCheckpoint.pendingToolCallIds,
    })

    const approvalTools = new Set(options.runtimeConfig.supervisor.approvalInterruptTools)
    const returnDirectToolNames = supervisorToolDefinitions
      .filter(tool => tool.agentResultMode === 'return_direct')
      .map(tool => tool.name)
    const supervisorTools = createAgentsTools(toolRegistry, approvalTools, {
      schemaMode: adapter.agentToolSchemaMode,
      allowedToolNames: new Set(supervisorToolDefinitions.map(tool => tool.name)),
    })
    const subAgentDependencies = {
      configs: subAgentConfigs,
      selectedModel,
      rootModel: subAgentRootModel,
      reasoning: options.reasoning,
      adapter,
      toolRegistry,
      approvalTools,
      store,
      runId: options.runId,
      threadId,
      eventSink,
      coordinator,
      executionGate,
      subAgentControls,
      ...(runtimeOptions.agentTracing ? { agentTracing: runtimeOptions.agentTracing } : {}),
    }
    const subAgentState = new SubAgentStateController(subAgentDependencies)
    await subAgentState.initialize(subAgentConfigs)
    const subAgentTools = await createSubAgentTools({
      ...subAgentDependencies,
      stateController: subAgentState,
    })
    const handoffIntegration = createHandoffAgents({
      ...subAgentDependencies,
      stateController: subAgentState,
    })

    const sandboxIntegration = buildRuntimeSdkSandboxIntegration(options.runtimeConfig, {
      executionGate,
      query: options.query,
    })
    const sandboxCapabilities = [
      ...coreSandboxCapabilities,
      ...sandboxIntegration.capabilities,
    ]
    const sandboxTools = sandboxCapabilities.flatMap(capability => capability.tools())
    const sandboxToolNames = new Set(sandboxTools.map(tool => tool.name))
    const sandboxManifest = sandboxEnabled
      ? buildSandboxManifest(
          options,
          threadId,
          sandboxIntegration.pathGrants,
          {
            artifactDirectory: await prepareRunArtifactDirectory(store.runtimeRoot, options.runId),
            artifactMounts: visibleArtifactResources.flatMap(toSandboxArtifactMount),
          },
        )
      : null
    const sandbox = sandboxManifest
      ? buildSandboxRunConfig(
          sandboxManifest,
          options.runtimeConfig.sandbox,
          runtimeOptions.createSandboxClient,
        )
      : undefined
    const reservedToolNames = new Set([
      ...toolRegistry.list().map(tool => tool.name),
      ...subAgentTools.map(tool => tool.name),
      ...handoffIntegration.handoffs.map(item => item.toolName),
    ])
    const hostedTools = createHostedTools(adapter, options.runtimeConfig)
    for (const tool of hostedTools) reservedToolNames.add(tool.name)
    const sdkIntegration = await createRuntimeSdkIntegration(
      options.runtimeConfig,
      reservedToolNames,
      executionGate,
    )
    const mcpConfigs = new Map(options.runtimeConfig.sdk.mcp.servers.map(server => [server.name, server]))
    const requestToolSources: AgentToolPlanSource[] = [
      ...supervisorToolDefinitions.map(platformToolPlanSource),
      ...subAgentTools.map(tool => sdkToolPlanSource({
        tool,
        kind: 'subagent',
        providerId: tool.name,
      })),
      ...sdkIntegration.tools.map(tool => {
        const serverName = sdkIntegration.mcpToolServers.get(tool.name)
        if (!serverName) throw new Error(`MCP 工具 '${tool.name}' 缺少 server 来源`)
        const server = mcpConfigs.get(serverName)
        if (!server) throw new Error(`MCP 工具 '${tool.name}' 引用了未知 server '${serverName}'`)
        return sdkToolPlanSource({
          tool,
          kind: 'mcp',
          providerId: serverName,
          requiresApproval: server.approval === 'always',
        })
      }),
      ...hostedTools.map(tool => sdkToolPlanSource({
        tool,
        kind: 'hosted',
        providerId: adapter.provider,
        readOnly: true,
        destructive: false,
      })),
      ...sandboxTools.map(tool => sdkToolPlanSource({
        tool,
        kind: 'sandbox',
        providerId: options.runtimeConfig.sandbox.backend,
        requiresApproval: true,
      })),
      ...[...handoffIntegration.toolAgentIds].map(([toolName, agentId]) => (
        handoffToolPlanSource({ toolName, agentId })
      )),
    ]
    captureModelRequest = async request => {
      const objectiveRevision = coordinator.currentModelInputObjectiveRevision()
      const toolPlan = createAgentToolPlan({ request, sources: requestToolSources })
      await stepContexts.record({
        runId: options.runId,
        turnId,
        segmentId,
        objectiveRevision,
        inputCursor: objectiveRevision - 1,
        provider: adapter.provider,
        modelId: selectedModel,
        transport: adapter.agentRuntimeCapabilities.transport,
        modelCapabilities,
        reasoningEffort: request.modelSettings.reasoning?.effort ?? null,
        serviceTier: null,
        timeoutMs: request.modelSettings.timeoutMs ?? 0,
        runtimeConfig: options.runtimeConfig,
        runtimeConfigDigest: configDigest,
        toolPlan,
        activeMcpServers: sdkIntegration.activeMcpServers,
        mcpToolServers: sdkIntegration.mcpToolServers,
        activeSkills: sandboxIntegration.activeSkills,
        auth: options.auth ?? null,
      })
    }

    const inputTranscript = await store.activeTranscript(threadId)
    const existingInputSummaries = new Map(inputTranscript.flatMap(entry => (
      entry.kind === 'checkpoint'
      && entry.payload.type === 'model_input_summary'
      && typeof entry.payload.sourceDigest === 'string'
      && typeof entry.payload.content === 'string'
        ? [[entry.payload.sourceDigest, entry.payload.content] as const]
        : []
    )))
    const modelInput = new RuntimeModelInputController({
      config: contextConfig,
      summarize,
      existingSummaries: existingInputSummaries,
      resolveToolOutput: callId => resolveToolOutputReference(store, threadId, callId),
      persistSummary: record => store.appendTranscript({
        threadId,
        runId: options.runId,
        turnId,
        kind: 'checkpoint',
        payload: {
          type: 'model_input_summary',
          sourceDigest: record.sourceDigest,
          content: record.summary,
          sourceItemCount: record.sourceItemCount,
          estimatedTokensBefore: record.estimatedTokensBefore,
          estimatedTokensAfter: record.estimatedTokensAfter,
        },
      }).then(() => undefined),
      updateEstimatedTokens: tokens => store.mutateRunState(options.runId, state => ({
        runtimeStats: {
          ...state.runtimeStats,
          contextEstimatedTokens: tokens,
          contextUsagePermille: Math.round(tokens / contextConfig.contextWindowTokens * 1000),
        },
      })).then(() => undefined),
    })
    await store.updateRunState(options.runId, {
      activeSkills: sandboxIntegration.activeSkills,
      activeMcpServers: sdkIntegration.activeMcpServers,
    })
    if (
      sandboxIntegration.activeSkills.length
      || sdkIntegration.activeMcpServers.length
      || hostedTools.length
    ) {
      eventSink.emit('step.started', 'SDK 扩展已装配', {
        active_skills: sandboxIntegration.activeSkills,
        skill_matches: sandboxIntegration.skillMatches,
        active_mcp_servers: sdkIntegration.activeMcpServers,
        active_hosted_tools: hostedTools.map(tool => tool.name),
      })
    }

    const explicitTools = [
      ...supervisorTools,
      ...subAgentTools,
      ...sdkIntegration.tools,
      ...hostedTools,
    ]
    const agentOptions: AgentOptions<AgentsExecutionContext> = {
      name: options.runtimeConfig.supervisor.name,
      instructions: () => buildSupervisorInstructions(),
      model,
      modelSettings: modelSettings(options.reasoning, modelCapabilities.capabilities.reasoning),
      resetToolChoice: true,
      tools: explicitTools,
      toolUseBehavior: { stopAtToolNames: returnDirectToolNames },
      handoffs: handoffIntegration.handoffs,
    }
    const agent: Agent<AgentsExecutionContext> = sandboxManifest
      ? new SandboxAgent<AgentsExecutionContext>({
        ...agentOptions,
      defaultManifest: sandboxManifest,
      capabilities: [
        ...sandboxCapabilities,
      ],
      })
      : new Agent<AgentsExecutionContext>(agentOptions)
    const unavailableSdkToolCallIds = new Set<string>()
    const runner = new Runner({
      model,
      // 平台 的本地 tracing 由 LocalAgentTracing 投影；SDK 外部导出始终关闭，
      // 避免把用户输入、工具参数或 DeepSeek 内容发送到另一个提供商。
      tracingDisabled: !runtimeOptions.agentTracing,
      traceIncludeSensitiveData: false,
      workflowName: `${PRODUCT_CODENAME} Agent Workflow`,
      groupId: threadId,
      traceMetadata: {
        runId: options.runId,
        threadId,
        sessionId: options.sessionId,
        provider: options.provider,
        modelName: selectedModel,
        transport: adapter.agentRuntimeCapabilities.transport,
      },
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
      await transcriptProjector.appendAssistantMessageTranscript(assembly, content)
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
        if (item.type === 'hosted_tool_call') {
          await flushPendingSessionAssistantMessage()
          await transcriptProjector.appendSdkHostedToolCallCheckpoint(
            options.runId,
            threadId,
            turnId,
            item,
            itemSink,
            sdkNativeToolPresentation(item.name, currentAssembly),
          )
          continue
        }
        if (item.type === 'function_call') {
          const transcript = await store.activeTranscript(threadId)
          const existingToolCall = transcript
            .find(entry => entry.kind === 'tool_call' && entry.payload.callId === item.callId)
          const itemObjectiveRevision = existingToolCall
            ? objectiveRevisionFromPayload(existingToolCall.payload, 1)
            : currentAssembly.context.currentObjectiveRevision()
          const exists = Boolean(existingToolCall)
          const terminal = transcript
            .some(entry => entry.kind === 'tool_result' && entry.payload.callId === item.callId)
          if (!exists) {
            if (unavailableSdkToolCallIds.has(item.callId)) {
              const label = currentAssembly.subAgentToolNames.has(item.name)
                ? '子智能体任务'
                : toolRegistry.get(item.name)?.label ?? item.name
              await transcriptProjector.appendSdkRejectedToolCallTranscript(
                options.runId,
                threadId,
                turnId,
                item,
                itemSink,
                label,
                itemObjectiveRevision,
              )
            } else if (toolRegistry.get(item.name)) {
              // SDK Session 与工具 invoke 的持久化回调没有先后契约。恢复或快模型
              // 路径中 Session 可能先看到 function_call；统一进入 coordinator 的
              // 单航班 prepare，不能把正常的回调反序当成损坏状态。
              await coordinator.prepare(
                item.name,
                parseArguments(item.arguments),
                item.callId,
              )
            } else if (currentAssembly.subAgentToolNames.has(item.name)) {
              throw new Error(`SDK Session 收到未准备的子智能体调用 '${item.callId}'`)
            } else {
              await transcriptProjector.appendSdkNativeToolCallTranscript(
                options.runId,
                threadId,
                turnId,
                item,
                itemSink,
                sdkNativeToolPresentation(item.name, currentAssembly),
                itemObjectiveRevision,
              )
            }
          }
          if (unavailableSdkToolCallIds.has(item.callId) || terminal) {
            await coordinator.markSdkToolCallTerminal(item.callId)
          } else if (!transcriptProjector.isPlatformManagedTool(item.name, currentAssembly)) {
            await coordinator.markSdkToolCallPending(item.callId)
          }
          if (pendingSessionAssistantContent) {
            await transcriptProjector.appendAssistantContentCheckpoint(
              assembly,
              item.callId,
              pendingSessionAssistantContent,
            )
            pendingSessionAssistantContent = null
          }
          continue
        }
        await flushPendingSessionAssistantMessage()
        if (item.type === 'function_call_result') {
          const transcript = await store.activeTranscript(threadId)
          const itemObjectiveRevision = objectiveRevisionForCall(
            transcript,
            item.callId,
          )
          const exists = transcript
            .some(entry => entry.kind === 'tool_result' && entry.payload.callId === item.callId)
          if (exists) {
            await coordinator.markSdkToolCallTerminal(item.callId)
            continue
          }
          const content = toolResultText(item.output)
          const isSubAgent = currentAssembly.subAgentToolNames.has(item.name)
          const isSdkRejectedTool = unavailableSdkToolCallIds.has(item.callId)
          const isSdkNativeTool = !isSdkRejectedTool
            && !transcriptProjector.isPlatformManagedTool(item.name, currentAssembly)
          const nativePresentation = sdkNativeToolPresentation(item.name, currentAssembly)
          const platformTool = toolRegistry.get(item.name)
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
          await store.appendTranscript({
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
                  : isSdkNativeTool
                    ? nativePresentation.label
                    : platformTool?.label ?? item.name,
              summary: content,
              content,
              contentRef: null,
              ledgerStatus,
              resultId: null,
              objectiveRevision: itemObjectiveRevision,
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
              metadata: {
                toolLabel: nativePresentation.label,
                source: nativePresentation.source,
                objectiveRevision: itemObjectiveRevision,
              },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: item.callId,
              name: item.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: {
                toolLabel: nativePresentation.label,
                source: nativePresentation.source,
                objectiveRevision: itemObjectiveRevision,
              },
            })
          }
          await coordinator.markSdkToolCallTerminal(item.callId)
          unavailableSdkToolCallIds.delete(item.callId)
        }
      }
    }
    const history = conversationMessagesToAgentItems(assembled.messages, systemPrompt)
    const session = new FileAgentsSession(
      `${options.sessionId}:${threadId}`,
      history,
      projectSessionItems,
    )
    const completedAssembly: RuntimeAssembly = {
      agent,
      runner,
      session,
      context,
      coordinator,
      adapter,
      modelName: selectedModel,
      modelCapabilities,
      ...(sandbox ? { sandbox } : {}),
      sdkIntegration,
      modelInput,
      configDigest,
      sdkVersion,
      threadId,
      turnId,
      subAgentToolNames: new Set(subAgentConfigs
        .filter(config => config.delegationMode === 'as_tool')
        .map(config => config.agentId)),
      handoffToolNames: new Set(handoffIntegration.handoffs.map(item => item.toolName)),
      handoffAgentNames: handoffIntegration.agentIds,
      mcpToolNames: sdkIntegration.mcpToolNames,
      hostedToolNames: new Set(hostedTools.map(tool => tool.name)),
      sandboxToolNames,
      isUnavailableSdkToolCall: callId => unavailableSdkToolCallIds.has(callId),
      completeHandoff: handoffIntegration.complete,
      failHandoff: handoffIntegration.fail,
      flushPendingSessionAssistantMessage,
      discardPendingSessionAssistantMessage,
    }
    assembly = completedAssembly
    return completedAssembly
  }
}

function objectiveRevisionForCall(
  entries: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
  callId: string,
): number {
  const toolCall = entries.find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
  if (!toolCall) throw new Error(`SDK Session 工具结果 '${callId}' 缺少 canonical tool_call`)
  return objectiveRevisionFromPayload(toolCall.payload, 1)
}

function objectiveRevisionFromPayload(payload: Record<string, unknown>, fallback: number): number {
  const value = payload.objectiveRevision
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function createThreadValueState(
  store: AgentRuntimeStore,
  threadId: string,
  currentRunId: string,
): Map<string, unknown> {
  const refs = visibleThreadValueRefs(store, threadId, currentRunId)
  return new Map<string, unknown>(refs.map(ref => [ref.refId, ref]))
}

function visibleThreadValueRefs(
  store: AgentRuntimeStore,
  threadId: string,
  currentRunId: string,
): ToolValueRef[] {
  const currentRun = store.getRun(currentRunId)
  const currentCreatedAt = Date.parse(currentRun.createdAt)
  const priorRuns = store.listRunsForThread(threadId)
    .filter(run => run.id !== currentRunId && Date.parse(run.createdAt) <= currentCreatedAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return [
    ...priorRuns.flatMap(run => run.state.toolValueRefs),
    ...currentRun.state.toolValueRefs,
  ]
}

async function resolveToolOutputReference(
  store: AgentRuntimeStore,
  threadId: string,
  callId: string,
): Promise<ToolOutputReference | null> {
  const entry = [...await store.activeTranscript(threadId)].reverse().find(candidate => (
    candidate.kind === 'tool_result' && candidate.payload.callId === callId
  ))
  if (!entry) return null
  const toolName = typeof entry.payload.name === 'string' ? entry.payload.name : 'tool'
  const summary = typeof entry.payload.summary === 'string'
    ? entry.payload.summary
    : '工具结果已保存'
  return {
    callId,
    toolName,
    resultId: typeof entry.payload.resultId === 'string' ? entry.payload.resultId : null,
    summary,
    valueRefIds: stringArray(entry.payload.valueRefIds),
    artifactIds: stringArray(entry.payload.artifactIds),
  }
}

function assertAgentRuntimeCapabilities(
  adapter: ModelAdapter,
  model: ModelCapabilitySnapshot,
  config: AgentRuntimeConfig,
): void {
  const capabilities = adapter.agentRuntimeCapabilities
  if (capabilities.structuredOutput === 'none' || !model.capabilities.structuredOutput) {
    throw new Error(`模型 '${model.modelId}' 不支持 Agent 结构化输出`)
  }
  if (!capabilities.functionTools || !model.capabilities.toolCalls) {
    throw new Error(`模型 '${model.modelId}' 不支持 Agent function tools`)
  }
  const enabledMcp = config.sdk.mcp.enabled
    ? config.sdk.mcp.servers.filter(server => server.enabled)
    : []
  if (enabledMcp.length && !capabilities.localMcp) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持本地 MCP 工具`)
  }
  if (config.subAgents.some(agent => agent.delegationMode === 'handoff') && !capabilities.handoffs) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 Agent handoff`)
  }
}

function sdkNativeToolPresentation(
  toolName: string,
  assembly: RuntimeAssembly,
): { label: string; source: string } {
  if (assembly.hostedToolNames.has(toolName) || toolName === 'web_search_call') {
    return { label: '联网搜索', source: 'openai_agents_hosted_web_search' }
  }
  if (assembly.handoffToolNames.has(toolName)) {
    return { label: 'Handoff 转交', source: 'openai_agents_handoff' }
  }
  if (assembly.mcpToolNames.has(toolName)) {
    return { label: 'MCP 工具调用', source: 'openai_agents_mcp' }
  }
  return { label: '沙箱工具调用', source: 'openai_agents_sandbox' }
}

function createHostedTools(
  adapter: ModelAdapter,
  config: AgentRuntimeConfig,
): Tool<AgentsExecutionContext>[] {
  if (!adapter.agentRuntimeCapabilities.hostedTools) return []
  const webSearch = config.sdk.hostedTools.webSearch
  if (!webSearch.enabled) return []
  return [
    webSearchTool({
      name: 'web_search',
      searchContextSize: webSearch.searchContextSize,
    }),
  ]
}

function planAwareSandboxCapabilities(executionGate: RunToolConcurrencyGate): Capability[] {
  return [
    filesystem({
      configureTools: tools => gateSandboxTools(tools, new Set(['view_image']), executionGate),
    }),
    shell({
      configureTools: tools => gateSandboxTools(tools, new Set(), executionGate),
    }),
  ]
}

function gateSandboxTools<TContext>(
  tools: Tool<TContext>[],
  planModeDiscoveryTools: ReadonlySet<string>,
  executionGate: RunToolConcurrencyGate,
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
      return executionGate.run('exclusive', () => tool.invoke(runContext, input, details))
    }
    return { ...tool, isEnabled, invoke }
  })
}

function memoryToolsAvailable(toolRegistry: ToolRegistry): boolean {
  return Boolean(toolRegistry.get('list_memories')
    && toolRegistry.get('search_memory')
    && toolRegistry.get('read_memory')
    && toolRegistry.get('write_memory')
    && toolRegistry.get('forget_memory'))
}

function toSandboxArtifactMount(resource: VisibleArtifactResource): SandboxArtifactMount[] {
  if (resource.availability !== 'available' || !resource.sourcePath || !resource.sandboxPath) return []
  return [{
    artifactId: resource.artifactId,
    runId: resource.runId,
    sourcePath: resource.sourcePath,
    sandboxPath: resource.sandboxPath,
  }]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : []
}
