// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 会话控制器
//
//   文件:       localAgentSession.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  analysisRunSchema,
  conversationItemSchema,
  runEventSchema,
  runSnapshotSchema,
  runSteeringRecordSchema,
  threadDetailSnapshotSchema,
  workspaceBootstrapSnapshotSchema,
  type AgentExecutionMode,
  type AnalysisRun,
  type ConversationItem,
  type DecisionRequest,
  type ModelProviderDescriptor,
  type RunEvent,
  type WorkspaceBootstrapSnapshot,
  type WsControlCommand,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import type { LocalAgentClient, LocalAgentPush } from '../transport/localAgentClient.js'

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'requires_action'])
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])
const ACTION_RUN_STATUSES = new Set(['clarification_needed', 'waiting_approval', 'requires_action'])

export interface LocalAgentClientPort {
  send<T>(type: WsControlCommand, payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>
  onPush(listener: (message: LocalAgentPush) => void): () => void
  onDisconnected(listener: (error: Error) => void): () => void
  close(): void
}

export interface LocalAgentSessionOptions {
  connectClient: () => Promise<LocalAgentClientPort | LocalAgentClient>
  provider?: string
  model?: string
  threadId?: string
  executionMode?: AgentExecutionMode
  reasoning?: boolean
}

export interface LocalAgentSessionSnapshot {
  connection: 'connecting' | 'online' | 'reconnecting' | 'closed'
  connectionMessage: string
  bootstrap: WorkspaceBootstrapSnapshot | null
  provider: ModelProviderDescriptor | null
  model: string | null
  executionMode: AgentExecutionMode
  reasoning: boolean
  threadId: string | null
  run: AnalysisRun | null
  items: ConversationItem[]
  events: RunEvent[]
  error: string | null
}

/**
 * CLI 只编排平台控制命令和投影。Runner、RunState、审批恢复和工具并发仍全部
 * 属于主 API 进程，断线后只重新订阅，不重放任何写命令。
 */
export class LocalAgentSession {
  private readonly events = new EventEmitter()
  private readonly options: LocalAgentSessionOptions
  private client: LocalAgentClientPort | null = null
  private disposePush: (() => void) | null = null
  private disposeDisconnected: (() => void) | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private closed = false
  private state: LocalAgentSessionSnapshot

  constructor(options: LocalAgentSessionOptions) {
    this.options = options
    this.state = {
      connection: 'connecting',
      connectionMessage: `正在连接 ${PRODUCT_CODENAME} API…`,
      bootstrap: null,
      provider: null,
      model: null,
      executionMode: options.executionMode ?? 'auto',
      reasoning: options.reasoning ?? true,
      threadId: options.threadId ?? null,
      run: null,
      items: [],
      events: [],
      error: null,
    }
  }

  async initialize(): Promise<LocalAgentSessionSnapshot> {
    await this.connect(false)
    return this.snapshot()
  }

  snapshot(): LocalAgentSessionSnapshot {
    return {
      ...this.state,
      items: [...this.state.items],
      events: [...this.state.events],
    }
  }

  subscribe(listener: (snapshot: LocalAgentSessionSnapshot) => void): () => void {
    this.events.on('state', listener)
    return () => this.events.off('state', listener)
  }

  async submit(text: string): Promise<AnalysisRun> {
    const query = text.trim()
    if (!query) throw new Error('问题不能为空。')
    const client = this.requireClient()
    const currentRun = this.state.run
    if (currentRun && ACTIVE_RUN_STATUSES.has(currentRun.status)) {
      await client.send('run:steer', {
        runId: currentRun.id,
        steeringId: `steer_${randomUUID()}`,
        content: query,
      }, runSteeringRecordSchema)
      return currentRun
    }
    if (currentRun && ACTION_RUN_STATUSES.has(currentRun.status)) {
      throw new Error('当前运行正在等待审批或澄清，请先处理界面中的决策。')
    }
    const bootstrap = this.requireBootstrap()
    const newThread = !this.state.threadId
    const payload: Record<string, unknown> = {
      query,
      provider: this.requireProvider().provider,
      executionMode: this.state.executionMode,
      reasoning: this.state.reasoning,
      ...(this.options.model ? { modelName: this.state.model } : {}),
      ...(this.state.threadId
        ? { threadId: this.state.threadId }
        : { sessionId: bootstrap.session.id }),
    }
    const run = await client.send('run:start', payload, analysisRunSchema)
    this.setState({
      run,
      threadId: run.threadId,
      items: newThread ? [] : this.state.items,
      events: [],
      error: null,
    })
    return run
  }

  async respondDecision(input: {
    decisionId: string
    optionId?: string | null
    text?: string | null
  }): Promise<AnalysisRun> {
    const current = this.requireRun()
    const next = await this.requireClient().send('run:respond-decision', {
      runId: current.id,
      decisionId: input.decisionId,
      ...(input.optionId !== undefined ? { optionId: input.optionId } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
    }, analysisRunSchema)
    this.setState({
      run: next,
      threadId: next.threadId,
      events: next.id === current.id ? this.state.events : [],
      error: null,
    })
    return next
  }

  async cancel(): Promise<AnalysisRun> {
    const run = this.requireRun()
    const cancelled = await this.requireClient().send('run:cancel', { runId: run.id }, analysisRunSchema)
    this.setState({ run: cancelled, error: null })
    return cancelled
  }

  async resume(): Promise<AnalysisRun> {
    const run = this.requireRun()
    const resumed = await this.requireClient().send('run:resume', { runId: run.id }, analysisRunSchema)
    this.setState({ run: resumed, error: null })
    return resumed
  }

  setExecutionMode(mode: AgentExecutionMode): void {
    this.setState({ executionMode: mode })
  }

  setReasoning(enabled: boolean): void {
    this.setState({ reasoning: enabled })
  }

  newConversation(): void {
    const currentRun = this.state.run
    if (currentRun && (
      ACTIVE_RUN_STATUSES.has(currentRun.status)
      || ACTION_RUN_STATUSES.has(currentRun.status)
    )) {
      throw new Error('当前运行尚未结束；请先取消、恢复或处理待决事项。')
    }
    this.setState({
      threadId: null,
      run: null,
      items: [],
      events: [],
      error: null,
    })
  }

  pendingDecision(): DecisionRequest | null {
    const decisions = this.state.run?.state.decisions ?? []
    return decisions.find(decision => decision.status === 'pending' && decision.kind === 'approval')
      ?? decisions.find(decision => decision.status === 'pending' && decision.kind === 'clarification')
      ?? null
  }

  waitForActionOrCompletion(timeoutMs: number): Promise<LocalAgentSessionSnapshot> {
    const settled = (): boolean => {
      const run = this.state.run
      return Boolean(run && (
        TERMINAL_RUN_STATUSES.has(run.status)
        || run.status === 'waiting_approval'
        || run.status === 'clarification_needed'
      ))
    }
    if (settled()) return Promise.resolve(this.snapshot())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose()
        reject(new Error(`Agent 运行在 ${Math.ceil(timeoutMs / 1000)} 秒内没有完成。`))
      }, timeoutMs)
      const dispose = this.subscribe(snapshot => {
        if (!settled()) return
        clearTimeout(timer)
        dispose()
        resolve(snapshot)
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.detachClient()
    this.setState({ connection: 'closed', connectionMessage: '已分离' })
    this.events.removeAllListeners()
  }

  private async connect(reconnecting: boolean): Promise<void> {
    if (this.closed) return
    this.setState({
      connection: reconnecting ? 'reconnecting' : 'connecting',
      connectionMessage: reconnecting
        ? '连接中断，正在恢复…'
        : `正在连接 ${PRODUCT_CODENAME} API…`,
    })
    const client = await this.options.connectClient()
    if (this.closed) {
      client.close()
      return
    }
    this.detachClient()
    this.client = client
    this.disposePush = client.onPush(message => this.handlePush(message))
    this.disposeDisconnected = client.onDisconnected(error => this.handleDisconnected(error))
    const bootstrap = await client.send('workspace:bootstrap', {}, workspaceBootstrapSnapshotSchema)
    const provider = selectProvider(bootstrap.providers, this.options.provider)
    const model = selectModel(provider, this.options.model)
    this.reconnectAttempt = 0
    this.setState({
      connection: 'online',
      connectionMessage: '已连接',
      bootstrap,
      provider,
      model,
      error: null,
    })
    if (this.state.run) {
      const snapshot = await client.send('run:subscribe', { runId: this.state.run.id }, runSnapshotSchema)
      this.absorbSnapshot(snapshot)
      return
    }
    if (this.state.threadId) {
      const detail = await client.send('thread:get', { threadId: this.state.threadId }, threadDetailSnapshotSchema)
      if (detail.latestRun) {
        const snapshot = await client.send('run:subscribe', { runId: detail.latestRun.id }, runSnapshotSchema)
        this.absorbSnapshot(snapshot)
      }
    }
  }

  private handlePush(message: LocalAgentPush): void {
    if (message.type === 'run.item') {
      const parsed = conversationItemSchema.safeParse(message.payload.data)
      if (parsed.success && (!this.state.threadId || parsed.data.threadId === this.state.threadId)) {
        this.setState({ items: upsertById(this.state.items, parsed.data, item => item.itemId) })
      }
      return
    }
    if (message.type === 'run.event') {
      const parsed = runEventSchema.safeParse(message.payload.data)
      if (parsed.success && parsed.data.runId === this.state.run?.id) {
        this.setState({ events: upsertById(this.state.events, parsed.data, event => event.eventId) })
      }
      return
    }
    if (message.type === 'run.snapshot') {
      const parsed = runSnapshotSchema.safeParse(message.payload.data)
      if (parsed.success) this.absorbSnapshot(parsed.data)
    }
  }

  private absorbSnapshot(snapshot: z.infer<typeof runSnapshotSchema>): void {
    if (this.state.run && snapshot.run.id !== this.state.run.id) return
    this.setState({
      run: snapshot.run,
      threadId: snapshot.run.threadId,
      items: mergeItems(this.state.items, snapshot.items),
      events: snapshot.events,
      error: snapshot.run.status === 'failed'
        ? snapshot.run.state.errors.at(-1) ?? '运行失败。'
        : null,
    })
  }

  private handleDisconnected(error: Error): void {
    if (this.closed) return
    this.detachClient()
    this.setState({
      connection: 'reconnecting',
      connectionMessage: `连接中断：${error.message}`,
      error: error.message,
    })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(5_000, 1_000 * (2 ** this.reconnectAttempt))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(true).catch(error => {
        if (this.closed) return
        this.setState({
          connection: 'reconnecting',
          connectionMessage: `恢复失败：${safeMessage(error)}；稍后重试`,
          error: safeMessage(error),
        })
        this.scheduleReconnect()
      })
    }, delay)
  }

  private detachClient(): void {
    this.disposePush?.()
    this.disposeDisconnected?.()
    this.disposePush = null
    this.disposeDisconnected = null
    this.client?.close()
    this.client = null
  }

  private requireClient(): LocalAgentClientPort {
    if (!this.client || this.state.connection !== 'online') {
      throw new Error(`${PRODUCT_CODENAME} API 尚未连接。`)
    }
    return this.client
  }

  private requireBootstrap(): WorkspaceBootstrapSnapshot {
    if (!this.state.bootstrap) throw new Error('Agent 工作区尚未初始化。')
    return this.state.bootstrap
  }

  private requireProvider(): ModelProviderDescriptor {
    if (!this.state.provider) throw new Error('没有可用的 Agent 模型提供商。')
    return this.state.provider
  }

  private requireRun(): AnalysisRun {
    if (!this.state.run) throw new Error('当前没有可操作的运行。')
    return this.state.run
  }

  private setState(update: Partial<LocalAgentSessionSnapshot>): void {
    this.state = { ...this.state, ...update }
    this.events.emit('state', this.snapshot())
  }
}

function selectProvider(
  providers: ModelProviderDescriptor[],
  requested: string | undefined,
): ModelProviderDescriptor {
  const provider = requested
    ? providers.find(candidate => candidate.provider === requested)
    : providers.find(candidate => candidate.configured
      && candidate.capabilities.includes('agents_sdk_live_supervisor'))
  if (!provider) {
    throw new Error(requested
      ? `模型提供商 '${requested}' 不存在。`
      : '没有已配置且支持 Agent SDK 主路径的模型提供商。')
  }
  if (!provider.configured) throw new Error(`${provider.displayName} 尚未正确配置。`)
  if (!provider.capabilities.includes('agents_sdk_live_supervisor')) {
    throw new Error(`${provider.displayName} 不是 Agent SDK 主运行路径。`)
  }
  return provider
}

function selectModel(provider: ModelProviderDescriptor, requested: string | undefined): string {
  const selected = requested?.trim() || provider.defaultModel
  if (!selected) throw new Error(`${provider.displayName} 没有配置默认模型。`)
  const allowed = provider.availableModels.length
    ? provider.availableModels
    : provider.defaultModel ? [provider.defaultModel] : []
  if (!allowed.includes(selected)) {
    throw new Error(
      `${provider.displayName} 模型 '${selected}' 未通过本地能力预检；可用模型：${allowed.join('、') || '未配置'}。`,
    )
  }
  return selected
}

function upsertById<T>(current: T[], incoming: T, id: (value: T) => string): T[] {
  const next = new Map(current.map(value => [id(value), value]))
  next.set(id(incoming), incoming)
  return [...next.values()]
}

function mergeItems(current: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const next = new Map(current.map(item => [item.itemId, item]))
  for (const item of incoming) next.set(item.itemId, item)
  return [...next.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.itemId.localeCompare(right.itemId))
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误。'
}
