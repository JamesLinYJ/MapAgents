// +-------------------------------------------------------------------------
//
//   地理智能平台 - DeepSeek Agents SDK Chat Completions 模型
//
//   文件:       deepSeekChatCompletionsModel.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 该模块是 DeepSeek OpenAI-compatible 传输层的唯一实现。Runner 负责
// Agent 编排，本模型只负责 DeepSeek Chat Completions 请求、响应与流事件。

import {
  Usage,
  UserError,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
  type ResponseStreamEvent,
  type SerializedHandoff,
  type SerializedTool,
} from '@openai/agents'
import { Ajv, type ValidateFunction } from 'ajv'
import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions'
import { logger } from '../observability/logger.js'

const FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/u
const RESERVED_PROVIDER_FIELDS = new Set([
  'model', 'messages', 'tools', 'stream', 'stream_options', 'response_format',
  'tool_choice', 'parallel_tool_calls', 'reasoning_effort',
  'previous_response_id', 'conversation', 'conversation_id',
  'context_management', 'prompt', 'input',
])

type DeepSeekAssistantMessage = ChatCompletion['choices'][number]['message'] & {
  reasoning?: string | null
  reasoning_content?: string | null
}

interface DeepSeekStreamChunk {
  id?: string
  choices?: Array<{
    index?: number
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: Record<string, number>
    completion_tokens_details?: Record<string, number>
  } | null
}

interface AccumulatedToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

type ModelOutput = Extract<ResponseStreamEvent, { type: 'response_done' }>['response']['output']

class DeepSeekModelStreamError extends Error {
  constructor(
    message: string,
    readonly replaySafe: boolean,
    readonly networkError: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DeepSeekModelStreamError'
  }
}

class DeepSeekStructuredOutputError extends Error {
  readonly outputKind: StructuredOutputKind
  readonly outputLength: number
  readonly outputDigest: string

  constructor(message: string, output: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeepSeekStructuredOutputError'
    this.outputKind = classifyStructuredOutput(output)
    this.outputLength = output.length
    this.outputDigest = digest(output)
  }
}

type StructuredOutputKind =
  | 'empty'
  | 'markdown_fence'
  | 'dsml'
  | 'truncated_json'
  | 'json_scalar'
  | 'non_json_text'
  | 'schema_mismatch'

export interface DeepSeekChatCompletionsModelOptions {
  client: OpenAI
  model: string
}

// DeepSeekChatCompletionsModel
//
// 使用官方 Agents SDK Model 契约和 openai npm 客户端，同时严格实现 DeepSeek
// V4 的 reasoning_content 回放规则，不接受 Responses 专属状态或工具能力。
export class DeepSeekChatCompletionsModel implements Model {
  readonly model: string
  private readonly client: OpenAI
  private previousCacheObservation?: CacheObservation

  constructor(options: DeepSeekChatCompletionsModelOptions) {
    if (!options.model.trim()) throw new Error('DeepSeek Chat Completions 模型名称不能为空')
    this.client = options.client
    this.model = options.model
  }

  getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    if (args.error instanceof DeepSeekModelStreamError) {
      if (!args.error.networkError) return undefined
      return {
        suggested: args.error.replaySafe,
        replaySafety: args.error.replaySafe ? 'safe' : 'unsafe',
        reason: args.error.message,
        normalized: { isNetworkError: args.error.networkError },
      }
    }
    return undefined
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const params = this.buildRequest(request, false)
    const maximumAttempts = request.outputType === 'text' ? 1 : 3
    const aggregateUsage = new Usage()
    const structuredOutputValidator = createStructuredOutputValidator(request.outputType)

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const attemptParams = attempt === 1
        ? params
        : toStructuredRetryRequest(params, attempt)
      try {
        const response = await this.client.chat.completions.create(attemptParams, { signal: request.signal })
        const choice = response.choices[0]
        if (!choice || response.choices.length !== 1) throw new Error('Chat Completions 必须返回且只能返回一个 choice')
        assertFinishReason(choice.finish_reason)
        const attemptUsage = new Usage(toUsage(response.usage))
        aggregateUsage.add(attemptUsage)
        this.observePromptCache(attemptParams, response.usage as DeepSeekStreamChunk['usage'])
        const message = choice.message as DeepSeekAssistantMessage
        if (!message.tool_calls?.length) {
          assertStructuredOutput(request.outputType, message.content ?? '', structuredOutputValidator)
        }
        const output = parseAssistantMessage(response.id, message)
        if (!output.length) throw new Error('Chat Completions 未返回正文或工具调用')
        return {
          usage: aggregateUsage,
          output,
          responseId: response.id,
          providerData: response as unknown as Record<string, unknown>,
        }
      } catch (error) {
        if (error instanceof DeepSeekStructuredOutputError && attempt < maximumAttempts && !request.signal?.aborted) {
          logger.info({
            model: this.model,
            attempt,
            finalizationWithoutTools: !attemptParams.tools?.length,
            outputKind: error.outputKind,
            outputLength: error.outputLength,
            outputDigest: error.outputDigest,
          }, 'DeepSeek structured output retry')
          continue
        }
        throw error
      }
    }

    throw new Error('DeepSeek 结构化输出重试流程异常结束')
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const params = this.buildRequest(request, true)
    const bufferStructuredTurn = request.outputType !== 'text'
    const maximumAttempts = bufferStructuredTurn ? 3 : 1
    const aggregateUsage = new Usage()
    const structuredOutputValidator = createStructuredOutputValidator(request.outputType)

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      // 重试沿用同一工具目录与已完成的工具历史；只有当前失败响应会被丢弃，
      // 已执行结果不会重放，模型仍可选择合法的后续控制或业务工具。
      const attemptParams = attempt === 1
        ? params
        : toStructuredRetryRequest(params, attempt)
      let emittedSemanticOutput = false
      const bufferedEvents: ResponseStreamEvent[] = []
      try {
        const stream = await this.client.chat.completions.create(attemptParams, { signal: request.signal }) as unknown as AsyncIterable<DeepSeekStreamChunk>
        let responseId = ''
        let text = ''
        let reasoning = ''
        let finishReason: string | null = null
        let usage: DeepSeekStreamChunk['usage']
        let started = false
        const calls = new Map<number, AccumulatedToolCall>()

        for await (const chunk of stream) {
          if (chunk.id) {
            if (responseId && responseId !== chunk.id) throw new Error('Chat Completions 流在同一响应中改变了 response id')
            responseId = chunk.id
          }
          if (chunk.usage) usage = chunk.usage
          const choices = chunk.choices ?? []
          if (choices.length === 0) {
            if (started) {
              const event: ResponseStreamEvent = { type: 'model', event: chunk, providerData: { source: 'openai_chat_completions' } }
              if (bufferStructuredTurn) bufferedEvents.push(event)
              else yield event
            }
            continue
          }
          const [choice] = choices
          if (choices.length !== 1 || !choice || (choice.index ?? 0) !== 0) {
            throw new Error('Chat Completions 流必须只包含 index=0 的 choice')
          }
          const delta = choice.delta
          const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content
          // DeepSeek 官方流式协议把 reasoning_content 与最终 content 视为互斥
          // 通道；思考分块即使携带 content 字段，也不能并入最终回答。
          const contentDelta = reasoningDelta ? undefined : delta?.content
          const hasSemanticOutput = Boolean(contentDelta || reasoningDelta || delta?.tool_calls?.length)
          if (hasSemanticOutput && !started) {
            started = true
            const event: ResponseStreamEvent = { type: 'response_started', providerData: { chunk } }
            if (bufferStructuredTurn) bufferedEvents.push(event)
            else yield event
          }
          if (started) {
            const event: ResponseStreamEvent = { type: 'model', event: chunk, providerData: { source: 'openai_chat_completions' } }
            if (bufferStructuredTurn) bufferedEvents.push(event)
            else yield event
          }
          if (hasSemanticOutput && !bufferStructuredTurn) emittedSemanticOutput = true
          if (contentDelta) {
            const previousText = text
            text = mergeDeltaOrSnapshot(text, contentDelta)
            const normalizedDelta = text.slice(previousText.length)
            if (normalizedDelta) {
              const event: ResponseStreamEvent = { type: 'output_text_delta', delta: normalizedDelta, providerData: { chunk } }
              if (bufferStructuredTurn) bufferedEvents.push(event)
              else yield event
            }
          }
          if (reasoningDelta) reasoning = mergeDeltaOrSnapshot(reasoning, reasoningDelta)
          for (const raw of delta?.tool_calls ?? []) accumulateToolCall(calls, raw)
          if (choice.finish_reason) {
            if (finishReason && finishReason !== choice.finish_reason) throw new Error('Chat Completions 流返回了冲突的 finish reason')
            finishReason = choice.finish_reason
          }
        }

        if (!started || !responseId) throw new Error('Chat Completions 流缺少响应标识')
        assertFinishReason(finishReason)
        const attemptUsage = new Usage(toUsage(usage))
        aggregateUsage.add(attemptUsage)
        this.observePromptCache(attemptParams, usage)
        if (calls.size === 0) {
          assertStructuredOutput(request.outputType, text, structuredOutputValidator)
        }
        const output = buildOutput(responseId, text, reasoning, [...calls.values()].sort((a, b) => a.index - b.index))
        if (!output.length) throw new Error('Chat Completions 流未返回正文或工具调用')
        const doneEvent: ResponseStreamEvent = {
          type: 'response_done',
          response: { id: responseId, usage: aggregateUsage, output },
        }
        if (bufferStructuredTurn) {
          bufferedEvents.push(doneEvent)
          for (const event of bufferedEvents) yield event
        } else {
          yield doneEvent
        }
        return
      } catch (error) {
        if (error instanceof DeepSeekStructuredOutputError && attempt < maximumAttempts && !request.signal?.aborted) {
          logger.info({
            model: this.model,
            attempt,
            finalizationWithoutTools: !attemptParams.tools?.length,
            outputKind: error.outputKind,
            outputLength: error.outputLength,
            outputDigest: error.outputDigest,
          }, 'DeepSeek structured output retry')
          continue
        }
        if (error instanceof UserError || error instanceof DeepSeekModelStreamError) throw error
        throw new DeepSeekModelStreamError(
          error instanceof Error ? error.message : String(error),
          !emittedSemanticOutput && isTransientNetworkError(error),
          isTransientNetworkError(error),
          { cause: error },
        )
      }
    }
  }

  private buildRequest(request: ModelRequest, stream: false): ChatCompletionCreateParamsNonStreaming
  private buildRequest(request: ModelRequest, stream: true): ChatCompletionCreateParamsStreaming
  private buildRequest(
    request: ModelRequest,
    stream: boolean,
  ): ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming {
    assertSupportedRequest(request)
    const messages = toChatMessages(request.input)
    const structuredOutputInstruction = toStructuredOutputInstruction(request.outputType)
    const systemInstructions = [
      request.systemInstructions,
      structuredOutputInstruction,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n\n')
    if (systemInstructions) messages.unshift({ role: 'system', content: systemInstructions })
    const tools = [
      ...request.tools.map(toChatTool),
      ...request.handoffs.map(toHandoffTool),
    ].sort((left, right) => chatToolName(left).localeCompare(chatToolName(right)))
    const providerData = request.modelSettings.providerData ?? {}
    for (const key of Object.keys(providerData)) {
      if (RESERVED_PROVIDER_FIELDS.has(key)) throw new UserError(`providerData 不得覆盖保留字段 '${key}'`)
    }
    const responseFormat = toResponseFormat(request.outputType)
    const providerThinkingDisabled = isRecord(providerData.thinking)
      && providerData.thinking.type === 'disabled'
    const providerThinkingConfigured = isRecord(providerData.thinking)
    if (!providerThinkingDisabled && isNonAutoToolChoice(request.modelSettings.toolChoice)) {
      throw new UserError('DeepSeek V4 thinking 模式不支持显式 toolChoice；请使用 auto，或显式关闭 thinking。')
    }
    const omitToolChoice = !providerThinkingDisabled
      && (request.modelSettings.toolChoice === undefined || request.modelSettings.toolChoice === 'auto')
    const toolChoice = toToolChoice(request.modelSettings.toolChoice, tools)
    return ({
      model: this.model,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: request.modelSettings.temperature,
      top_p: request.modelSettings.topP,
      frequency_penalty: request.modelSettings.frequencyPenalty,
      presence_penalty: request.modelSettings.presencePenalty,
      max_tokens: request.modelSettings.maxTokens,
      ...(!omitToolChoice && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(!providerThinkingDisabled && request.modelSettings.reasoning?.effort
        ? { reasoning_effort: request.modelSettings.reasoning.effort }
        : {}),
      ...(!providerThinkingConfigured && request.modelSettings.reasoning?.effort
        ? { thinking: { type: 'enabled' } }
        : {}),
      ...providerData,
    } as unknown) as ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming
  }

  private observePromptCache(
    params: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
    usage: DeepSeekStreamChunk['usage'],
  ): void {
    if (!usage || typeof usage.prompt_cache_hit_tokens !== 'number') return
    const current: CacheObservation = {
      at: Date.now(),
      hitTokens: Math.max(0, Math.trunc(usage.prompt_cache_hit_tokens)),
      fingerprints: requestCacheFingerprints(params),
    }
    const previous = this.previousCacheObservation
    this.previousCacheObservation = current
    if (!previous) return
    const drop = previous.hitTokens - current.hitTokens
    if (drop < Math.max(2_000, Math.ceil(previous.hitTokens * 0.05))) return
    const changed = Object.keys(current.fingerprints).filter(key => (
      current.fingerprints[key as keyof CacheFingerprints] !== previous.fingerprints[key as keyof CacheFingerprints]
    ))
    logger.info({
      model: this.model,
      previousHitTokens: previous.hitTokens,
      currentHitTokens: current.hitTokens,
      elapsedMs: current.at - previous.at,
      changedComponents: changed,
      likelyCause: changed.length ? 'request_prefix_changed' : 'provider_eviction_expiry_or_best_effort_miss',
    }, 'DeepSeek prompt cache hit tokens dropped')
  }
}

interface CacheFingerprints {
  modelSettings: string
  systemPrefix: string
  tools: string
  historyPrefix: string
}

interface CacheObservation {
  at: number
  hitTokens: number
  fingerprints: CacheFingerprints
}

function requestCacheFingerprints(
  params: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
): CacheFingerprints {
  const messages = params.messages
  const systemMessages = messages.filter(message => message.role === 'system')
  return {
    modelSettings: digest({
      model: params.model,
      temperature: params.temperature,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      response_format: params.response_format,
      tool_choice: params.tool_choice,
      reasoning_effort: 'reasoning_effort' in params ? params.reasoning_effort : undefined,
    }),
    systemPrefix: digest(systemMessages),
    tools: digest(params.tools ?? []),
    historyPrefix: digest(messages.slice(0, -1)),
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeJson(value))).digest('hex')
}

function assertSupportedRequest(request: ModelRequest): void {
  if (request.previousResponseId) throw new UserError('Chat Completions 不支持 previousResponseId')
  if (request.conversationId) throw new UserError('Chat Completions 不支持远程 conversationId')
  if (request.prompt) throw new UserError('Chat Completions 不支持 reusable prompt')
  if (request.modelSettings.contextManagement?.length) throw new UserError('Chat Completions 不支持服务端 compaction')
  for (const tool of request.tools) {
    if (tool.type !== 'function') throw new UserError(`Chat Completions 不支持工具类型 '${tool.type}'`)
    if (tool.namespace) throw new UserError('Chat Completions 不支持 namespaced function tool')
    if (tool.deferLoading) throw new UserError('Chat Completions 不支持 deferred function tool')
  }
}

function toChatMessages(input: string | AgentInputItem[]): ChatCompletionMessageParam[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  const messages: ChatCompletionMessageParam[] = []
  let pendingReasoning = ''
  let pendingAssistant: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  } | null = null
  const flush = () => {
    if (!pendingAssistant) return
    const value = pendingAssistant
    pendingAssistant = null
    if (!value.tool_calls.length && !value.content?.trim()) {
      throw new UserError('历史 assistant 消息缺少正文或工具调用')
    }
    if (value.tool_calls.length && value.content === null) value.content = ''
    messages.push({ ...value, tool_calls: value.tool_calls.length ? value.tool_calls : undefined } as ChatCompletionMessageParam)
  }
  const assistant = () => pendingAssistant ??= { role: 'assistant', content: null, tool_calls: [] }

  for (const item of input) {
    if (isMessage(item)) {
      flush()
      pendingReasoning = ''
      if (item.role === 'system') messages.push({ role: 'system', content: String(item.content) })
      else if (item.role === 'user') messages.push({ role: 'user', content: extractUserText(item.content) })
      else {
        const content = extractAssistantText(item.content)
        if (!content.trim()) throw new UserError('历史 assistant 消息缺少正文或工具调用')
        messages.push({ role: 'assistant', content })
      }
      continue
    }
    if (item.type === 'reasoning') {
      // DeepSeek 要求工具调用回合在后续请求中完整回放 reasoning_content。
      pendingReasoning += reasoningText(item)
      continue
    }
    if (item.type === 'function_call') {
      if (!item.callId || !item.name || !FUNCTION_NAME.test(item.name)) throw new UserError('历史工具调用缺少合法 callId/name')
      const message = assistant()
      if (pendingReasoning && !message.reasoning_content) message.reasoning_content = pendingReasoning
      pendingReasoning = ''
      message.tool_calls.push({
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      })
      continue
    }
    if (item.type === 'function_call_result') {
      flush()
      if (!item.callId) throw new UserError('历史工具结果缺少 callId')
      messages.push({ role: 'tool', tool_call_id: item.callId, content: extractToolText(item.output) })
      continue
    }
    throw new UserError(`Chat Completions 不支持历史项 '${item.type}'`)
  }
  flush()
  return messages
}

function toChatTool(tool: SerializedTool): ChatCompletionTool {
  if (tool.type !== 'function') throw new UserError(`Chat Completions 不支持工具类型 '${tool.type}'`)
  if (!FUNCTION_NAME.test(tool.name)) throw new UserError(`工具名称 '${tool.name}' 不符合 Chat Completions 约束`)
  // DeepSeek 的 strict function calling 是 /beta 专属能力。GeoForge 使用稳定
  // Chat Completions 端点，因此不发送该 Beta 字段；SDK 仍会在本地按同一
  // schema 严格校验工具参数。
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: canonicalizeJson(tool.parameters) as Record<string, unknown>,
    },
  }
}

function toHandoffTool(handoff: SerializedHandoff): ChatCompletionTool {
  if (!FUNCTION_NAME.test(handoff.toolName)) throw new UserError(`handoff 名称 '${handoff.toolName}' 不合法`)
  return {
    type: 'function',
    function: {
      name: handoff.toolName,
      description: handoff.toolDescription || '',
      parameters: canonicalizeJson(handoff.inputJsonSchema) as Record<string, unknown>,
    },
  }
}

function toResponseFormat(outputType: ModelRequest['outputType']): Record<string, unknown> | undefined {
  if (outputType === 'text') return undefined
  return { type: 'json_object' }
}

// DeepSeek 官方说明 JSON Output 偶尔可能返回空内容，并建议修改提示后重试。
// 失败响应没有产生可执行副作用；历史工具结果已经作为独立消息固定在上下文中，
// 因此重试必须保留当前工具目录。删除工具会让已进入计划模式的运行失去
// request_clarification / submit_agent_workflow 等合法收口路径。
function toStructuredRetryRequest<
  T extends ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
>(params: T, attempt: number): T {
  const retryNumber = Math.max(1, attempt - 1)
  const hasExecutedToolResult = params.messages.some(message => message.role === 'tool')
  const shouldDisableThinking = hasExecutedToolResult || attempt >= 3
  const result = {
    ...params,
    messages: [
      ...params.messages,
      {
        role: 'user',
        content: [
          `<structured_output_retry attempt="${retryNumber}">`,
          '上一响应为空、不是合法 JSON object，或不符合既定 schema，未被系统接受。',
          hasExecutedToolResult
            ? '请根据已有工具结果继续当前任务：若仍需调用当前可用工具，请返回合法工具调用；否则只输出一个以 { 开始、以 } 结束且符合既定 schema 的 JSON object。'
            : '如果回答依赖可用工具数据，请先返回合法工具调用；否则只输出一个以 { 开始、以 } 结束且符合既定 schema 的 JSON object。',
          '不要输出 Markdown 代码围栏、解释、前后缀或空白占位。',
          '</structured_output_retry>',
        ].join('\n'),
      },
    ],
  } as T
  if (shouldDisableThinking) {
    delete result.reasoning_effort
    Object.assign(result, { thinking: { type: 'disabled' } })
  }
  return result
}

// DeepSeek json_object 承诺返回单个合法 JSON object。适配器在供应商边界
// 先验证该协议，再把正文交给 Agents SDK 做业务 schema 校验，避免把传输层
// 拼接错误误报成业务 outputType 错误。
function assertStructuredOutput(
  outputType: ModelRequest['outputType'],
  text: string,
  validator: ValidateFunction<unknown> | null,
): void {
  if (outputType === 'text') return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DeepSeekStructuredOutputError('DeepSeek JSON Output 未返回单个合法 JSON object', text, { cause: error })
  }
  if (!isRecord(parsed)) throw new DeepSeekStructuredOutputError('DeepSeek JSON Output 的根值必须是 JSON object', text)
  if (validator && !validator(parsed)) {
    throw new DeepSeekStructuredOutputError('DeepSeek JSON Output 不符合既定 schema', text)
  }
}

function createStructuredOutputValidator(
  outputType: ModelRequest['outputType'],
): ValidateFunction<unknown> | null {
  if (outputType === 'text' || outputType.type !== 'json_schema') return null
  try {
    return new Ajv({ allErrors: true, strict: false }).compile(outputType.schema)
  } catch {
    throw new UserError('DeepSeek 结构化输出 schema 无法编译')
  }
}

function classifyStructuredOutput(text: string): StructuredOutputKind {
  const trimmed = text.trim()
  if (!trimmed) return 'empty'
  if (trimmed.startsWith('```')) return 'markdown_fence'
  if (/DSML|<tool_calls?>|<invoke\b/iu.test(trimmed)) return 'dsml'
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !/[}\]]\s*$/u.test(trimmed)) return 'truncated_json'
  try {
    return isRecord(JSON.parse(trimmed)) ? 'schema_mismatch' : 'json_scalar'
  } catch {
    return 'non_json_text'
  }
}

// DeepSeek Chat Completions 只公开 json_object；SDK 的 schema 仍由最终输出
// parser 严格校验。把 canonical schema 放入稳定 system 后缀，既遵守供应商
// 协议，也让相同 Agent 的提示前缀可命中缓存。
function toStructuredOutputInstruction(outputType: ModelRequest['outputType']): string | undefined {
  if (outputType === 'text') return undefined
  if (outputType.type === 'json_schema') {
    const canonicalSchema = canonicalizeJson(outputType.schema)
    const example = jsonSchemaExample(canonicalSchema, canonicalSchema)
    if (!isRecord(example)) {
      throw new UserError('DeepSeek json_object 只支持 JSON object 根类型的结构化输出')
    }
    const schema = JSON.stringify(canonicalSchema)
    return [
      '<structured_output>',
      '最终回答必须只包含一个有效 JSON object，不要使用 Markdown 代码围栏或附加正文。',
      `JSON 必须严格符合以下 schema：${schema}`,
      `EXAMPLE JSON OUTPUT:\n${JSON.stringify(example)}`,
      '</structured_output>',
    ].join('\n')
  }
  return [
    '<structured_output>',
    '最终回答必须只包含一个有效 JSON object，不要使用 Markdown 代码围栏或附加正文。',
    'EXAMPLE JSON OUTPUT:\n{}',
    '</structured_output>',
  ].join('\n')
}

// DeepSeek 的 json_object 协议要求提示中包含 JSON 输出样例。这里从 SDK
// 传入的 schema 生成稳定、最小的对象样例，避免在业务提示中维护第二份结构定义。
function jsonSchemaExample(schema: unknown, root: unknown, seenRefs = new Set<string>()): unknown {
  if (!isRecord(schema)) return null
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if ('default' in schema) return schema.default

  if (typeof schema.$ref === 'string') {
    if (seenRefs.has(schema.$ref)) return null
    const target = resolveLocalSchemaRef(root, schema.$ref)
    if (target === undefined) return null
    return jsonSchemaExample(target, root, new Set([...seenRefs, schema.$ref]))
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const candidates = schema[keyword]
    if (!Array.isArray(candidates) || !candidates.length) continue
    const nullable = candidates.find(candidate => isRecord(candidate) && candidate.type === 'null')
    if (nullable) return null
    return jsonSchemaExample(candidates[0], root, seenRefs)
  }

  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map(part => jsonSchemaExample(part, root, seenRefs))
    if (parts.every(isRecord)) return Object.assign({}, ...parts)
    return parts[0] ?? null
  }

  const type = Array.isArray(schema.type)
    ? schema.type.find(candidate => candidate !== 'null')
    : schema.type
  if (type === 'object' || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    return Object.fromEntries(Object.entries(properties).map(([name, property]) => (
      [name, jsonSchemaExample(property, root, seenRefs)]
    )))
  }
  if (type === 'array') {
    const minimum = typeof schema.minItems === 'number' ? Math.max(0, Math.trunc(schema.minItems)) : 0
    return Array.from({ length: minimum }, () => jsonSchemaExample(schema.items, root, seenRefs))
  }
  if (type === 'string') return schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : '示例'
  if (type === 'integer' || type === 'number') {
    if (typeof schema.minimum === 'number') return type === 'integer' ? Math.ceil(schema.minimum) : schema.minimum
    if (typeof schema.exclusiveMinimum === 'number') {
      return type === 'integer' ? Math.floor(schema.exclusiveMinimum) + 1 : schema.exclusiveMinimum + 1
    }
    return 0
  }
  if (type === 'boolean') return true
  return null
}

function resolveLocalSchemaRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (!isRecord(current) || !(segment in current)) return undefined
    current = current[segment]
  }
  return current
}

function toToolChoice(choice: ModelRequest['modelSettings']['toolChoice'], tools: ChatCompletionTool[]): unknown {
  if (!choice || choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (!tools.some(tool => tool.type === 'function' && tool.function.name === choice)) {
    throw new UserError(`toolChoice 指向未知工具 '${choice}'`)
  }
  return { type: 'function', function: { name: choice } }
}

function chatToolName(tool: ChatCompletionTool): string {
  return 'function' in tool ? tool.function.name : ''
}

function isNonAutoToolChoice(choice: ModelRequest['modelSettings']['toolChoice']): boolean {
  return Boolean(choice && choice !== 'auto')
}

function reasoningText(item: Extract<AgentInputItem, { type: 'reasoning' }>): string {
  return (item.rawContent ?? [])
    .map(part => isRecord(part) && part.type === 'reasoning_text' && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function parseAssistantMessage(responseId: string, message: DeepSeekAssistantMessage): ModelOutput {
  const calls = (message.tool_calls ?? []).map((call, index) => {
    if (call.type !== 'function') throw new UserError(`不支持工具调用类型 '${call.type}'`)
    return { index, id: call.id, name: call.function.name, arguments: call.function.arguments }
  })
  return buildOutput(responseId, message.content ?? '', message.reasoning ?? message.reasoning_content ?? '', calls)
}

function buildOutput(responseId: string, text: string, reasoning: string, calls: AccumulatedToolCall[]): ModelOutput {
  const output: ModelOutput = []
  if (reasoning) output.push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: reasoning }] })
  // DeepSeek 在工具调用帧中可能同时返回仅含空白的 content。空白不是一条
  // assistant 消息；若投影进 SDK Session，下一轮会形成无正文的历史消息。
  if (text.trim()) {
    output.push({
      id: responseId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    })
  }
  for (const call of calls) {
    if (!call.id || !call.name || !FUNCTION_NAME.test(call.name)) throw new Error('工具调用缺少合法 callId/name')
    const parsed = JSON.parse(call.arguments || '{}') as unknown
    if (!isRecord(parsed)) throw new Error(`工具 '${call.name}' 参数必须为 JSON object`)
    output.push({
      id: responseId,
      type: 'function_call',
      status: 'completed',
      callId: call.id,
      name: call.name,
      arguments: call.arguments || '{}',
    })
  }
  return output
}

function accumulateToolCall(
  calls: Map<number, AccumulatedToolCall>,
  raw: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } },
): void {
  const index = raw.index
  if (!Number.isInteger(index) || (index ?? -1) < 0) throw new Error('工具调用缺少合法 index')
  if (raw.type && raw.type !== 'function') throw new Error(`不支持工具调用类型 '${raw.type}'`)
  const current = calls.get(index!) ?? { index: index!, id: '', name: '', arguments: '' }
  if (raw.id) {
    if (current.id && current.id !== raw.id) throw new Error(`工具索引 ${index} 返回冲突 callId`)
    current.id = raw.id
  }
  if (raw.function?.name) current.name = mergeDeltaOrSnapshot(current.name, raw.function.name)
  if (raw.function?.arguments) current.arguments = mergeDeltaOrSnapshot(current.arguments, raw.function.arguments)
  calls.set(index!, current)
}

export function mergeDeltaOrSnapshot(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current || incoming.startsWith(current)) return incoming
  return current + incoming
}

function assertFinishReason(reason: string | null | undefined): void {
  if (reason === 'stop' || reason === 'tool_calls') return
  if (!reason) throw new Error('Chat Completions 响应未正常结束')
  throw new Error(`Chat Completions 未完整交付，finish_reason=${reason}`)
}

function toUsage(usage: DeepSeekStreamChunk['usage'] | ChatCompletion['usage'] | null | undefined) {
  const cacheUsage = usage as DeepSeekStreamChunk['usage']
  return {
    requests: 1,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokensDetails: {
      ...numericDetails(usage?.prompt_tokens_details),
      ...(typeof cacheUsage?.prompt_cache_hit_tokens === 'number'
        ? { prompt_cache_hit_tokens: cacheUsage.prompt_cache_hit_tokens }
        : {}),
      ...(typeof cacheUsage?.prompt_cache_miss_tokens === 'number'
        ? { prompt_cache_miss_tokens: cacheUsage.prompt_cache_miss_tokens }
        : {}),
    },
    outputTokensDetails: numericDetails(usage?.completion_tokens_details),
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, canonicalizeJson(value[key])]),
  )
}

function numericDetails(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

function isMessage(item: AgentInputItem): item is Extract<AgentInputItem, { role: string }> {
  return item.type === 'message' || (typeof item.type === 'undefined' && 'role' in item)
}

function extractUserText(content: Extract<AgentInputItem, { role: 'user' }>['content']): string {
  if (typeof content === 'string') return content
  const unsupported = content.filter(part => part.type !== 'input_text')
  if (unsupported.length) throw new UserError('Chat Completions 当前只接受文本用户消息')
  return content.map(part => part.type === 'input_text' ? part.text : '').join('')
}

function extractAssistantText(content: Extract<AgentInputItem, { role: 'assistant' }>['content']): string {
  return content.map(part => {
    if (part.type === 'output_text') return part.text
    if (part.type === 'refusal') return part.refusal
    throw new UserError(`Chat Completions 不支持 assistant 内容 '${part.type}'`)
  }).join('')
}

function extractToolText(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): string {
  if (typeof output === 'string') {
    if (!output.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return output
  }
  if (Array.isArray(output) && output.every(part => part.type === 'input_text')) {
    const text = output.map(part => part.type === 'input_text' ? part.text : '').join('')
    if (!text.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return text
  }
  if (isRecord(output) && output.type === 'text' && typeof output.text === 'string') {
    if (!output.text.trim()) throw new UserError('Chat Completions 工具结果不能为空')
    return output.text
  }
  throw new UserError('Chat Completions 工具结果必须是非空文本')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return [
    'terminated', 'fetch failed', 'econnreset', 'etimedout', 'socket hang up',
    'premature close', 'connection reset', 'connection error',
  ].some(marker => message.includes(marker))
}
