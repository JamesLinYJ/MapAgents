// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制面
//
//   文件:       subAgentControlPlane.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 控制面只管理同一 Runner 内已经由 Agent.asTool()/handoff() 创建的子智能体。
// 它不会自行启动模型循环。追问通过动态 instructions 在子智能体下一次模型调用
// 前注入；Agent-as-tool 取消只中止对应嵌套调用，不触碰根 Run 的 AbortController。

import type { SubAgentState } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { makeId, nowUtc } from '../utils/ids.js'

type SubAgentControlStore = Pick<AgentRuntimeStore,
  | 'appendAgentTranscript'
  | 'appendEvent'
  | 'getRun'
  | 'mutateRunState'
>

interface ActiveSubAgentInvocation {
  runId: string
  agentId: string
  callId: string
  delegationMode: 'as_tool' | 'handoff'
  controller: AbortController | null
  stallAfterMs: number
  stallTimer: ReturnType<typeof setTimeout> | null
  lastPersistedActivityAt: number
  cancellationReason: string | null
  terminalClaimed: boolean
}

export interface BeginSubAgentInvocationInput {
  runId: string
  agentId: string
  callId: string
  delegationMode: 'as_tool' | 'handoff'
  timeoutMs: number
}

export interface SubAgentControlInput {
  runId: string
  agentId: string
  controlId: string
  content: string
  createdByUserId: string
}

export class SubAgentControlPlane {
  private readonly active = new Map<string, ActiveSubAgentInvocation>()

  constructor(
    private readonly store: SubAgentControlStore,
    private readonly minimumStallMs = 5_000,
    private readonly maximumStallMs = 30_000,
  ) {}

  begin(input: BeginSubAgentInvocationInput): AbortSignal | null {
    const key = activeKey(input.runId, input.agentId)
    if (this.active.has(key)) {
      throw new Error(`子 Agent '${input.agentId}' 已有活动调用，不能并发复用同一身份。`)
    }
    const controller = input.delegationMode === 'as_tool' ? new AbortController() : null
    const stallAfterMs = Math.min(
      this.maximumStallMs,
      Math.max(this.minimumStallMs, Math.floor(input.timeoutMs / 3)),
    )
    const invocation: ActiveSubAgentInvocation = {
      ...input,
      controller,
      stallAfterMs,
      stallTimer: null,
      lastPersistedActivityAt: 0,
      cancellationReason: null,
      terminalClaimed: false,
    }
    this.active.set(key, invocation)
    this.scheduleStallCheck(invocation)
    return controller?.signal ?? null
  }

  finish(runId: string, agentId: string, callId: string): void {
    const key = activeKey(runId, agentId)
    const invocation = this.active.get(key)
    if (!invocation || invocation.callId !== callId) return
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    this.active.delete(key)
  }

  claimTerminalOutcome(
    runId: string,
    agentId: string,
    callId: string,
  ): { status: 'completed' } | { status: 'cancelled'; reason: string } {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation || invocation.callId !== callId) {
      throw new Error(`子 Agent '${agentId}' 的活动调用 '${callId}' 不存在。`)
    }
    if (invocation.terminalClaimed) {
      throw new Error(`子 Agent '${agentId}' 的调用 '${callId}' 已由其他终态处理。`)
    }
    invocation.terminalClaimed = true
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    return invocation.cancellationReason
      ? { status: 'cancelled', reason: invocation.cancellationReason }
      : { status: 'completed' }
  }

  finishRun(runId: string): void {
    const prefix = `${runId}\u0000`
    for (const [key, invocation] of this.active) {
      if (!key.startsWith(prefix)) continue
      if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
      this.active.delete(key)
    }
  }

  isCancellationRequested(runId: string, agentId: string, callId: string): boolean {
    const invocation = this.active.get(activeKey(runId, agentId))
    return invocation?.callId === callId && invocation.cancellationReason !== null
  }

  cancellationReason(runId: string, agentId: string, callId: string): string {
    const invocation = this.active.get(activeKey(runId, agentId))
    return invocation?.callId === callId && invocation.cancellationReason
      ? invocation.cancellationReason
      : '用户取消了子智能体任务。'
  }

  async followUp(input: SubAgentControlInput): Promise<SubAgentState> {
    const invocation = this.requireActive(input.runId, input.agentId)
    const content = input.content.trim()
    if (!content) throw new Error('子智能体追问内容不能为空。')
    const createdAt = nowUtc()
    const run = await this.store.mutateRunState(input.runId, state => ({
      subAgents: state.subAgents.map(agent => {
        if (agent.agentId !== input.agentId) return agent
        const existing = agent.controls.find(control => control.controlId === input.controlId)
        if (existing) return agent
        if (agent.status !== 'running') throw new Error(`子 Agent '${input.agentId}' 当前不可追问。`)
        return {
          ...agent,
          controls: [...agent.controls, {
            controlId: input.controlId,
            kind: 'follow_up' as const,
            content,
            status: 'queued' as const,
            createdByUserId: input.createdByUserId,
            createdAt,
            deliveredAt: null,
          }],
          latestMessage: '已收到用户追问，等待下一次模型调用处理',
          lastActivityAt: createdAt,
        }
      }),
    }))
    await this.store.appendAgentTranscript(input.runId, input.agentId, {
      type: 'control',
      controlId: input.controlId,
      kind: 'follow_up',
      content,
      createdByUserId: input.createdByUserId,
    })
    await this.appendControlEvent(input.runId, `${agentName(run.state.subAgents, input.agentId)} 收到用户追问`, {
      agentId: input.agentId,
      callId: invocation.callId,
      controlId: input.controlId,
      controlKind: 'follow_up',
      createdByUserId: input.createdByUserId,
    })
    return requireSubAgent(run.state.subAgents, input.agentId)
  }

  async cancel(input: SubAgentControlInput): Promise<SubAgentState> {
    const invocation = this.requireActive(input.runId, input.agentId)
    const reason = input.content.trim() || '用户取消了子智能体任务。'
    if (invocation.terminalClaimed) {
      throw new Error(`子 Agent '${input.agentId}' 已进入终态处理，不能再取消。`)
    }
    // 先在同一个同步临界区记录取消意图。完成路径随后只能
    // 领取 cancelled 终态，不会在持久化 await 窗口中反向覆盖为 completed。
    invocation.cancellationReason = reason
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    invocation.controller?.abort(new SubAgentCancelledError(reason))
    const createdAt = nowUtc()
    const run = await this.store.mutateRunState(input.runId, state => ({
      subAgents: state.subAgents.map(agent => {
        if (agent.agentId !== input.agentId) return agent
        const existing = agent.controls.find(control => control.controlId === input.controlId)
        if (existing) return agent
        if (agent.status !== 'running') throw new Error(`子 Agent '${input.agentId}' 当前不可取消。`)
        return {
          ...agent,
          status: 'cancelling' as const,
          controls: [...agent.controls, {
            controlId: input.controlId,
            kind: 'cancel' as const,
            content: reason,
            status: invocation.controller ? 'delivered' as const : 'queued' as const,
            createdByUserId: input.createdByUserId,
            createdAt,
            deliveredAt: invocation.controller ? createdAt : null,
          }],
          latestMessage: '正在取消当前子智能体调用',
          lastActivityAt: createdAt,
          stalled: false,
          stalledSince: null,
        }
      }),
    }))
    await this.store.appendAgentTranscript(input.runId, input.agentId, {
      type: 'control',
      controlId: input.controlId,
      kind: 'cancel',
      content: reason,
      createdByUserId: input.createdByUserId,
    })
    await this.appendControlEvent(input.runId, `${agentName(run.state.subAgents, input.agentId)} 收到取消请求`, {
      agentId: input.agentId,
      callId: invocation.callId,
      controlId: input.controlId,
      controlKind: 'cancel',
      createdByUserId: input.createdByUserId,
      isolated: invocation.delegationMode === 'as_tool',
    })
    return requireSubAgent(run.state.subAgents, input.agentId)
  }

  async consumeInstructions(runId: string, agentId: string): Promise<string[]> {
    const deliveredAt = nowUtc()
    const messages: string[] = []
    await this.store.mutateRunState(runId, state => ({
      subAgents: state.subAgents.map(agent => {
        if (agent.agentId !== agentId) return agent
        const queued = agent.controls.filter(control => control.status === 'queued')
        if (!queued.length) return agent
        for (const control of queued) {
          messages.push(control.kind === 'cancel'
            ? `平台控制：用户请求取消当前子智能体任务。原因：${control.content}。请停止继续调用工具，并立即如实结束当前交付。`
            : `用户追加追问：${control.content}`)
        }
        return {
          ...agent,
          controls: agent.controls.map(control => control.status === 'queued'
            ? { ...control, status: 'delivered' as const, deliveredAt }
            : control),
          lastActivityAt: deliveredAt,
          latestMessage: queued.some(control => control.kind === 'cancel')
            ? '取消请求已送达子智能体'
            : '用户追问已送达子智能体',
        }
      }),
    }))
    return messages
  }

  async touch(runId: string, agentId: string, currentStep: string): Promise<void> {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation) return
    this.scheduleStallCheck(invocation)
    const now = Date.now()
    if (now - invocation.lastPersistedActivityAt < 500) return
    invocation.lastPersistedActivityAt = now
    const timestamp = new Date(now).toISOString()
    await this.store.mutateRunState(runId, state => ({
      subAgents: state.subAgents.map(agent => agent.agentId === agentId
        ? {
            ...agent,
            currentStep,
            activityCount: agent.activityCount + 1,
            progressPercent: agent.status === 'running'
              ? Math.min(90, Math.max(10, (agent.progressPercent ?? 0) + 5))
              : agent.progressPercent,
            lastActivityAt: timestamp,
            stalled: false,
            stalledSince: null,
          }
        : agent),
    }))
  }

  private requireActive(runId: string, agentId: string): ActiveSubAgentInvocation {
    const invocation = this.active.get(activeKey(runId, agentId))
    if (!invocation) throw new Error(`子 Agent '${agentId}' 当前没有活动调用。`)
    return invocation
  }

  private scheduleStallCheck(invocation: ActiveSubAgentInvocation): void {
    if (invocation.stallTimer) clearTimeout(invocation.stallTimer)
    invocation.stallTimer = setTimeout(() => {
      void this.markStalled(invocation).catch(error => {
        logger.warn({
          error: errorLogPayload(error),
          runId: invocation.runId,
          agentId: invocation.agentId,
        }, 'subagent stalled state update failed')
      })
    }, invocation.stallAfterMs)
    invocation.stallTimer.unref?.()
  }

  private async markStalled(invocation: ActiveSubAgentInvocation): Promise<void> {
    const current = this.active.get(activeKey(invocation.runId, invocation.agentId))
    if (current !== invocation || current.cancellationReason) return
    const stalledSince = nowUtc()
    const run = await this.store.mutateRunState(invocation.runId, state => ({
      subAgents: state.subAgents.map(agent => (
        agent.agentId === invocation.agentId && agent.status === 'running'
          ? {
              ...agent,
              stalled: true,
              stalledSince,
              latestMessage: `超过 ${invocation.stallAfterMs}ms 未观察到新活动`,
            }
          : agent
      )),
    }))
    const agent = requireSubAgent(run.state.subAgents, invocation.agentId)
    if (!agent.stalled) return
    await this.appendControlEvent(invocation.runId, `${agent.name} 可能卡顿`, {
      agentId: invocation.agentId,
      callId: invocation.callId,
      stalledSince,
      stallAfterMs: invocation.stallAfterMs,
    })
  }

  private async appendControlEvent(
    runId: string,
    message: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.appendEvent(runId, {
      eventId: makeId('evt'),
      runId,
      threadId: run.threadId,
      type: 'subagent.updated',
      message,
      timestamp: nowUtc(),
      payload,
    })
  }
}

export class SubAgentCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubAgentCancelledError'
  }
}

function activeKey(runId: string, agentId: string): string {
  return `${runId}\u0000${agentId}`
}

function requireSubAgent(subAgents: SubAgentState[], agentId: string): SubAgentState {
  const agent = subAgents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new Error(`子 Agent '${agentId}' 不存在。`)
  return agent
}

function agentName(subAgents: SubAgentState[], agentId: string): string {
  return requireSubAgent(subAgents, agentId).name
}
