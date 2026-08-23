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

import { createHash } from 'node:crypto'
import type { AgentInputItem, Model, ModelRequest } from '@openai/agents'
import type { RuntimeContextConfig } from '../schemas/types.js'
import { estimateTextTokens } from './tokenEstimate.js'

export interface RuntimeModelInputData {
  input: AgentInputItem[]
  instructions?: string
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
  estimatedTokensBefore: number
  estimatedTokensAfter: number
}

interface RuntimeModelInputControllerOptions {
  config: RuntimeContextConfig
  summarize(prompt: string): Promise<string>
  resolveToolOutput(callId: string): Promise<ToolOutputReference | null>
  persistSummary(record: PersistedModelInputSummary): Promise<void>
  existingSummaries?: ReadonlyMap<string, string>
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

    const boundary = safeCompactionBoundary(
      reduced,
      this.options.config.preserveRecentTurns,
    )
    const leadingSystemCount = countLeadingSystemMessages(reduced)
    if (boundary <= leadingSystemCount) {
      await this.reportEstimatedTokens(estimatedBefore)
      if (estimatedBefore >= hardLimit) {
        throw new Error('模型上下文已达到硬上限，且没有可安全压缩的完整旧消息组。请新建任务或减少输入。')
      }
      return withInstructions(reduced, modelData.instructions)
    }

    const sourceItems = reduced.slice(leadingSystemCount, boundary)
    const modelVisibleSourceItems = sourceItems.map(stripRunInputMarkerForModel)
    const sourceDigest = digestItems(modelVisibleSourceItems)
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
      ...reduced.slice(0, leadingSystemCount),
      summaryItem,
      ...reduced.slice(boundary),
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
        estimatedTokensBefore: estimatedBefore,
        estimatedTokensAfter: estimatedAfter,
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
    const preserveFrom = safeCompactionBoundary(
      items,
      this.options.config.preserveRecentTurns,
    )
    const output: AgentInputItem[] = []
    for (const [index, item] of items.entries()) {
      if (
        index >= preserveFrom
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

function safeCompactionBoundary(items: AgentInputItem[], preserveRecentTurns: number): number {
  let boundary = recentTurnBoundary(items, preserveRecentTurns)
  const calls = new Map<string, number>()
  const results = new Map<string, number>()
  for (const [index, item] of items.entries()) {
    if (item.type === 'function_call') calls.set(item.callId, index)
    if (item.type === 'function_call_result') results.set(item.callId, index)
  }
  for (const [callId, callIndex] of calls) {
    const resultIndex = results.get(callId)
    if (resultIndex === undefined) {
      boundary = Math.min(boundary, callIndex)
      continue
    }
    if ((callIndex < boundary) !== (resultIndex < boundary)) {
      boundary = Math.min(boundary, callIndex, resultIndex)
    }
  }
  for (const [callId, resultIndex] of results) {
    const callIndex = calls.get(callId)
    if (callIndex === undefined) boundary = Math.min(boundary, resultIndex)
  }
  while (boundary > 0 && items[boundary - 1]?.type === 'reasoning') boundary -= 1
  return Math.max(countLeadingSystemMessages(items), boundary)
}

function recentTurnBoundary(items: AgentInputItem[], preserveRecentTurns: number): number {
  let remaining = Math.max(1, preserveRecentTurns)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && 'role' in item && item.role === 'user') {
      remaining -= 1
      if (remaining === 0) return index
    }
  }
  return countLeadingSystemMessages(items)
}

function countLeadingSystemMessages(items: AgentInputItem[]): number {
  let count = 0
  for (const item of items) {
    if ('role' in item && item.role === 'system') count += 1
    else break
  }
  return count
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

function digestItems(items: AgentInputItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex')
}

function buildSummaryPrompt(items: AgentInputItem[]): string {
  return [
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
