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
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import type { AuthContext } from '../security/types.js'
import type { AgentWorkflowStep, TodoItem } from '../schemas/types.js'
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

  constructor(private readonly options: CoordinatorOptions) {}

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
    return formatToolResultForModel(result, this.options.inlineToolResultMaxChars)
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
    const stepId = await this.claimAgentWorkflowStep(agentId, args, callId, agentId)
    this.externalAgentCalls.set(callId, agentId)
    return stepId
  }

  async completeExternalAgentStep(callId: string, summary: string): Promise<void> {
    try {
      await this.completeClaimedAgentWorkflowStep(callId, summary)
    } finally {
      this.externalAgentCalls.delete(callId)
    }
  }

  async failExternalAgentStep(callId: string, message: string): Promise<void> {
    try {
      await this.failClaimedAgentWorkflowStep(callId, message)
    } finally {
      this.externalAgentCalls.delete(callId)
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
    return formatToolResultForModel(result, this.options.inlineToolResultMaxChars)
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
        const run = this.options.store.getRun(this.options.runId)
        await this.options.store.updateRunState(this.options.runId, {
          warnings: [...run.state.warnings, `工具“${this.toolLabel(toolName)}”调用失败：${message}`],
          errors: [...run.state.errors, message],
          failedTool: toolName,
        })
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

  // 计划模式是硬运行边界：模型可以读、查、分析和提交退出计划，
  // 但不能在审批前写文件、导出、导入、执行破坏性工具或产生业务副作用。
  private assertPlanModeAllows(toolName: string): void {
    const run = this.options.store.getRun(this.options.runId)
    if (!run.state.planMode) return
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.isReadOnly || toolName === 'submit_agent_workflow' || toolName === 'enter_plan_mode') return
    throw new Error(`计划模式禁止执行写入或副作用工具 '${toolName}'。请先用 submit_agent_workflow 提交计划并等待批准。`)
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
      const run = this.options.store.getRun(this.options.runId)
      const workflow = run.state.agentWorkflow
      if (!workflow) return null
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
      const next = startAgentWorkflowStep(workflow, { stepId: step.stepId })
      const nextStep = next.steps.find(item => item.stepId === step.stepId)
      if (!nextStep) throw new Error(`工具开始时智能体工作流步骤 '${step.stepId}' 不存在。`)
      await this.options.store.updateRunState(this.options.runId, {
        agentWorkflow: next,
        todos: projectWorkflowStepToTodos(run.state.todos, nextStep),
      })
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
      const run = this.options.store.getRun(this.options.runId)
      const workflow = run.state.agentWorkflow
      if (!workflow) throw new Error('工具完成时智能体工作流状态缺失。')
      const step = workflow.steps.find(item => item.stepId === stepId)
      if (!step) throw new Error(`工具完成时智能体工作流步骤 '${stepId}' 不存在。`)
      const next = completeAgentWorkflowStep(workflow, { stepId, resultSummary: summary })
      const nextStep = next.steps.find(item => item.stepId === stepId)
      if (!nextStep) throw new Error(`工具完成时智能体工作流步骤 '${stepId}' 不存在。`)
      await this.options.store.updateRunState(this.options.runId, {
        agentWorkflow: next,
        todos: projectWorkflowStepToTodos(run.state.todos, nextStep),
      })
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
      const run = this.options.store.getRun(this.options.runId)
      const workflow = run.state.agentWorkflow
      if (!workflow) return
      const next = failAgentWorkflowStep(workflow, { stepId, errorMessage: message })
      const nextStep = next.steps.find(item => item.stepId === stepId)
      if (!nextStep) throw new Error(`工具失败时智能体工作流步骤 '${stepId}' 不存在。`)
      await this.options.store.updateRunState(this.options.runId, {
        agentWorkflow: next,
        todos: projectWorkflowStepToTodos(run.state.todos, nextStep),
      })
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
      invokeStructuredModel: prompt => {
        if (!this.options.adapter) throw new Error('当前确定性工具链未配置结构化模型调用')
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

const AGENT_WORKFLOW_CONTROL_TOOLS = new Set([
  'request_clarification',
  'enter_plan_mode',
  'submit_agent_workflow',
  'revise_agent_workflow',
  'todo_write',
])

export function formatToolResultForModel(result: ToolResult, maxChars: number): string {
  const base = {
    message: result.message,
    valueRefs: summarizeValueRefs(result.valueRefs ?? []),
    artifacts: (result.artifacts ?? []).map(artifact => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
    })),
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
// valueRef 清单。大数组保留长度与少量样例，避免后续工具从海量 payload 里误取 ref。
function summarizePayload(value: unknown, depth = 0): unknown {
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
