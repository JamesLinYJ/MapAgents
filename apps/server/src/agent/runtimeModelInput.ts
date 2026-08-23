// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runner 模型输入预算控制
//
//   文件:       runtimeModelInput.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem, Model, ModelRequest } from '@openai/agents'
import type { RuntimeContextConfig } from '../schemas/types.js'
import {
  buildAgentInputContextUnits,
  flattenContextUnits,
  selectContextCompactionSlice,
} from '../agent-runtime/context/ContextUnit.js'
import { estimateTextTokens } from './tokenEstimate.js'

const MODEL_INPUT_SUMMARY_PROMPT_VERSION = 'run-history-summary-v2'

export interface RuntimeModelInputData {
  input: AgentInputItem[]
  instructions?: string
}

export class ModelRequestContextBudgetExceededError extends Error {
  readonly code = 'model_request_context_budget_exceeded'

  constructor(
    readonly estimatedTokens: number,
    readonly hardLimitTokens: number,
  ) {
    super(`精确模型请求需要约 ${estimatedTokens} tokens，超过硬限制 ${hardLimitTokens} tokens。`)
    this.name = 'ModelRequestContextBudgetExceededError'
  }
}

export interface ToolOutputReference {
  callId: string
  toolName: string
  resultId: string | null
  summary: string
  valueRefIds: string[]
  artifactIds: string[]
}

export interface PersistedModelInputSummary {
  sourceDigest: string
  summary: string
  sourceItemCount: number
  sourceUnitIds: string[]
  sourceEntryIds: string[]
  sourceObjectHashes: string[]
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  summaryProvider: string
  summaryModel: string
  promptVersion: string
}

interface RuntimeModelInputControllerOptions {
  config: RuntimeContextConfig
  summarize(prompt: string): Promise<string>
  resolveToolOutput(callId: string): Promise<ToolOutputReference | null>
  persistSummary(record: PersistedModelInputSummary): Promise<void>
  existingSummaries?: ReadonlyMap<string, string>
  summaryIdentity: {
    provider: string
    model: string
  }
  updateEstimatedTokens(tokens: number): Promise<void>
}

// 跨轮压缩仍由 contextManager 维护 canonical transcript；这里仅控制单次
// Runner 调用的模型输入。任何压缩都以完整旧消息/工具组为单位，不改写事实源。
export class RuntimeModelInputController {
  private readonly summaries: Map<string, string>
  private readonly persistedDigests: Set<string>
  private lastReportedTokens: number | null = null

  constructor(private readonly options: RuntimeModelInputControllerOptions) {
    this.summaries = new Map(options.existingSummaries)
    this.persistedDigests = new Set(options.existingSummaries?.keys() ?? [])
  }

  async filter(
    modelData: RuntimeModelInputData,
    appendedItems: AgentInputItem[],
  ): Promise<RuntimeModelInputData> {
    const combined = [...modelData.input, ...appendedItems]
    const reduced = await this.reduceLargeToolOutputs(combined)
    const instructions = modelData.instructions ?? ''
    const estimatedBefore = estimateInputTokens(reduced, instructions)
    const compactThreshold = Math.floor(
      this.options.config.contextWindowTokens * this.options.config.compactRatio,
    )
    const hardLimit = Math.floor(
      this.options.config.contextWindowTokens * this.options.config.hardLimitRatio,
    )
    if (estimatedBefore < compactThreshold) {
      await this.reportEstimatedTokens(estimatedBefore)
      return withInstructions(reduced, modelData.instructions)
    }

    const units = buildAgentInputContextUnits(reduced, {
      projectItem: stripRunInputMarkerForModel,
    })
    const selection = selectContextCompactionSlice(
      units,
      this.options.config.preserveRecentTurns,
    )
    if (!selection.sourceUnits.length || !selection.sourceDigest) {
      await this.reportEstimatedTokens(estimatedBefore)
      if (estimatedBefore >= hardLimit) {
        throw new Error('模型上下文已达到硬上限，且没有可安全压缩的完整旧消息组。请新建任务或减少输入。')
      }
      return withInstructions(reduced, modelData.instructions)
    }

    const sourceItems = flattenContextUnits(selection.sourceUnits)
    const modelVisibleSourceItems = sourceItems.map(stripRunInputMarkerForModel)
    const sourceDigest = selection.sourceDigest
    let summary = this.summaries.get(sourceDigest)
    if (!summary) {
      summary = (await this.options.summarize(buildSummaryPrompt(modelVisibleSourceItems))).trim()
      if (!summary) throw new Error('运行中上下文压缩失败：摘要模型返回空内容。')
      this.summaries.set(sourceDigest, summary)
    }
    const summaryItem: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<run-history-summary source-digest="${sourceDigest}">\n${summary}\n</run-history-summary>`,
    }
    const nextInput = [
      ...flattenContextUnits(selection.leadingUnits),
      summaryItem,
      ...flattenContextUnits(selection.preservedUnits),
    ]
    const estimatedAfter = estimateInputTokens(nextInput, instructions)
    if (estimatedAfter >= hardLimit) {
      await this.reportEstimatedTokens(estimatedAfter)
      throw new Error('模型上下文压缩后仍达到硬上限；为避免破坏工具调用或推理配对，运行已停止。')
    }
    if (!this.persistedDigests.has(sourceDigest)) {
      await this.options.persistSummary({
        sourceDigest,
        summary,
        sourceItemCount: sourceItems.length,
        sourceUnitIds: selection.sourceUnits.map(unit => unit.unitId),
        sourceEntryIds: selection.sourceEntryIds,
        sourceObjectHashes: selection.sourceUnits.flatMap(unit => (
          unit.objectHash ? [unit.objectHash] : []
        )),
        estimatedTokensBefore: estimatedBefore,
        estimatedTokensAfter: estimatedAfter,
        summaryProvider: this.options.summaryIdentity.provider,
        summaryModel: this.options.summaryIdentity.model,
        promptVersion: MODEL_INPUT_SUMMARY_PROMPT_VERSION,
      })
      this.persistedDigests.add(sourceDigest)
    }
    await this.reportEstimatedTokens(estimatedAfter)
    return withInstructions(nextInput, modelData.instructions)
  }

  private async reportEstimatedTokens(tokens: number): Promise<void> {
    if (this.lastReportedTokens === tokens) return
    await this.options.updateEstimatedTokens(tokens)
    this.lastReportedTokens = tokens
  }

  private async reduceLargeToolOutputs(items: AgentInputItem[]): Promise<AgentInputItem[]> {
    const selection = selectContextCompactionSlice(
      buildAgentInputContextUnits(items, { projectItem: stripRunInputMarkerForModel }),
      this.options.config.preserveRecentTurns,
    )
    const compactableItems = new Set(flattenContextUnits(selection.sourceUnits))
    const output: AgentInputItem[] = []
    for (const item of items) {
      if (
        !compactableItems.has(item)
        || item.type !== 'function_call_result'
        || serializedOutputLength(item.output) <= this.options.config.inlineToolResultMaxChars
      ) {
        output.push(item)
        continue
      }
      const reference = await this.options.resolveToolOutput(item.callId)
      if (!reference) {
        output.push(item)
        continue
      }
      output.push({
        ...item,
        output: JSON.stringify({
          summary: reference.summary,
          resultId: reference.resultId,
          valueRefIds: reference.valueRefIds,
          artifactIds: reference.artifactIds,
          note: '大型结果已从模型上下文缩减；完整内容仍保存在平台事实源中。',
        }),
      })
    }
    return output
  }
}

const protectedModels = new WeakMap<Model, Model>()

export type ModelRequestObserver = (request: ModelRequest) => Promise<ModelRequest>

// filter 的返回值同时用于 SDK Session 持久化，不能在这里删除 delivery
// marker；否则外层 Runner 会把无 marker 副本再次写入历史。模型边界仅对
// 即将发给 provider 的请求副本脱敏，RunState/Session 继续保留幂等键。
export function protectModelTransportFromRunInputMarkers(
  model: Model,
  observeRequest?: ModelRequestObserver,
): Model {
  if (!observeRequest) {
    const existing = protectedModels.get(model)
    if (existing) return existing
  }
  const protectedModel: Model = {
    getResponse: async request => {
      const protectedRequest = stripRunInputMarkersFromRequest(request)
      const committedRequest = observeRequest
        ? await observeRequest(protectedRequest)
        : protectedRequest
      return model.getResponse(committedRequest)
    },
    getStreamedResponse: request => observeStreamedRequest(
      model,
      stripRunInputMarkersFromRequest(request),
      observeRequest,
    ),
    getRetryAdvice: args => model.getRetryAdvice?.(args),
  }
  if (!observeRequest) {
    protectedModels.set(model, protectedModel)
    protectedModels.set(protectedModel, protectedModel)
  }
  return protectedModel
}

/**
 * transport 边界的请求还包含工具目录、handoff、输出 schema 与 GeoWorld 基线，
 * 它们不一定出现在 SDK 的 history filter 中。provider I/O 前必须按最终可见
 * 请求重新核对硬上限，不能只相信压缩前的历史估算。
 */
export function assertModelRequestWithinContextBudget(
  request: ModelRequest,
  config: Pick<RuntimeContextConfig, 'contextWindowTokens' | 'hardLimitRatio'>,
): number {
  const estimatedTokens = estimateTextTokens(JSON.stringify({
    input: typeof request.input === 'string'
      ? request.input
      : request.input.map(stripRunInputMarkerForModel),
    systemInstructions: request.systemInstructions ?? null,
    tools: request.tools,
    handoffs: request.handoffs,
    outputType: request.outputType,
  }))
  const hardLimitTokens = Math.floor(config.contextWindowTokens * config.hardLimitRatio)
  if (estimatedTokens >= hardLimitTokens) {
    throw new ModelRequestContextBudgetExceededError(estimatedTokens, hardLimitTokens)
  }
  return estimatedTokens
}

async function* observeStreamedRequest(
  model: Model,
  request: ModelRequest,
  observer: ModelRequestObserver | undefined,
): ReturnType<Model['getStreamedResponse']> {
  const committedRequest = observer ? await observer(request) : request
  yield* model.getStreamedResponse(committedRequest)
}

function stripRunInputMarkersFromRequest(request: ModelRequest): ModelRequest {
  if (typeof request.input === 'string') return request
  return { ...request, input: request.input.map(stripRunInputMarkerForModel) }
}

function stripRunInputMarkerForModel(item: AgentInputItem): AgentInputItem {
  if (!('providerData' in item) || !item.providerData) return item
  if (!Object.prototype.hasOwnProperty.call(item.providerData, 'geoAgentRunInput')) return item

  const copy = structuredClone(item)
  if (!('providerData' in copy) || !copy.providerData) return copy
  const providerData: Record<string, unknown> = { ...copy.providerData }
  delete providerData.geoAgentRunInput
  if (Object.keys(providerData).length === 0) {
    delete copy.providerData
  } else {
    copy.providerData = providerData
  }
  return copy
}

function estimateInputTokens(items: AgentInputItem[], instructions: string): number {
  return estimateTextTokens(
    JSON.stringify(items.map(stripRunInputMarkerForModel)),
    instructions,
  )
}

function serializedOutputLength(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): number {
  return typeof output === 'string' ? output.length : JSON.stringify(output).length
}

function buildSummaryPrompt(items: AgentInputItem[]): string {
  return [
    `摘要协议版本：${MODEL_INPUT_SUMMARY_PROMPT_VERSION}`,
    '请将以下完整旧对话组压缩为可供后续 Agent 继续工作的中文事实摘要。',
    '保留用户约束、已经确认的结论、工具结果引用、失败与未解决事项；不得补充未出现的事实。',
    '不要输出工具调用协议或代码块，只输出信息密集的摘要正文。',
    '',
    JSON.stringify(items),
  ].join('\n')
}

function withInstructions(
  input: AgentInputItem[],
  instructions: string | undefined,
): RuntimeModelInputData {
  return instructions === undefined ? { input } : { input, instructions }
}
