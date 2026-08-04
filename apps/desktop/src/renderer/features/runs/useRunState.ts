// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行状态 Hook
//
//   文件:       useRunState.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useEffect, useReducer, useRef, startTransition } from 'react'
import type {
  AgentState,
  AnalysisRun,
  ArtifactRef,
  AgentWorkflow,
  RunEvent,
  UserIntent,
  ConversationItem,
} from '@geo-agent-platform/shared-types'
import { ConversationProjectionIndex } from '@geo-agent-platform/conversation-presentation'
import {
  subscribeRun,
  unsubscribeRun,
} from '../../api/client'
import { wsClient } from '../../ws/client'
import { isRecord } from '../../shared/utils/guards'
import { reportClientDiagnostic } from '../../shared/utils/clientDiagnostics'

// 运行状态所有权
//
// 这个 hook 只持有服务端 run 的 UI 投影：完成态通过 hydrate 获取事实快照，
// 聊天态通过 ConversationItem 追加；切换 run 时必须清理旧 item，避免历史串台。

export interface RunState {
  run?: AnalysisRun
  agentState?: AgentState
  intent?: UserIntent
  agentWorkflow?: AgentWorkflow
  events: RunEvent[]
  artifacts: ArtifactRef[]
  isSubmitting: boolean
  uiError?: string
  seenEventIds: Set<string>
  placeResolution?: { status: string; selected?: { latitude?: number | null; longitude?: number | null } | null } | null
  featureCount?: number
  items: ConversationItem[]
}

const MAX_EVENTS = 1000

function initialState(): RunState {
  return { events: [], items: [], artifacts: [], isSubmitting: false, seenEventIds: new Set() }
}

function formatHydrationError(error: unknown) {
  // hydrate 错误必须显式浮出到 UI。
  //
  // 完成态快照是最终结果和 artifact 的事实来源；失败时不能静默吞掉。
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return '刷新运行状态失败。'
}

function mergeConversationItems(current: ConversationItem[], incoming: ConversationItem[]) {
  // ConversationItem 是聊天事实源。
  //
  // started/delta/completed 可能反复更新同一个 itemId；索引负责 upsert、
  // transcript 去重和稳定排序，避免直播与刷新后的展示规则分叉。
  const projection = new ConversationProjectionIndex(current, 'live')
  projection.upsertMany(incoming, 'live')
  return projection.toArray()
}

// Reducer 只做纯状态转移
//
// 网络订阅、hydrate 和提交态收敛都在 hook 层完成，避免 render 期间写 ref
// 或由 effect 同步派生 React 本身已经能表达的状态。

export type RunAction =
  | { type: 'SET_RUN'; run: AnalysisRun; agentState: AgentState; intent?: UserIntent; plan?: AgentWorkflow; artifacts: ArtifactRef[] }
  | { type: 'CLEAR_RUN' }
  | { type: 'APPEND_EVENT'; event: RunEvent }
  | { type: 'SET_EVENTS'; events: RunEvent[] }
  | { type: 'APPEND_ITEM'; item: ConversationItem }
  | { type: 'SET_PROJECTED_ITEMS'; items: ConversationItem[] }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'SET_ERROR'; error?: string }
  | { type: 'SET_INTENT'; intent: UserIntent }
  | { type: 'SET_PLAN'; plan: AgentWorkflow }
  | { type: 'APPEND_ARTIFACT'; artifact: ArtifactRef }
  | { type: 'SET_ITEMS'; items: ConversationItem[] }
  | { type: 'SET_PLACE_RESOLUTION'; placeResolution: RunState['placeResolution'] }

// 导出 reducer 以便测试直接验证 CLEAR_RUN / SET_RUN 等状态转移；
// 不依赖 React 渲染环境。
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'SET_RUN': {
      const isDifferentRun = state.run?.id !== action.run.id
      const run = isDifferentRun
        ? action.run
        : mergeRunLifecycleProjection(state.run, action.run)
      const isRunning = run.status === 'running'
      return {
        ...state,
        run,
        agentState: run === action.run ? action.agentState : state.agentState,
        intent: run === action.run ? action.intent : state.intent,
        agentWorkflow: run === action.run ? action.plan : state.agentWorkflow,
        artifacts: run === action.run ? action.artifacts ?? [] : state.artifacts,
        placeResolution: run === action.run
          ? action.agentState.placeResolution ?? null
          : state.placeResolution,
        isSubmitting: isDifferentRun ? isRunning : isRunning ? state.isSubmitting : false,
        uiError: isDifferentRun ? undefined : state.uiError,
        events: isDifferentRun ? [] : state.events,
        seenEventIds: isDifferentRun ? new Set<string>() : state.seenEventIds,
        items: isDifferentRun ? [] : state.items,
      }
    }
    case 'SET_ITEMS':
      return { ...state, items: mergeConversationItems([], action.items) }
    case 'SET_PROJECTED_ITEMS':
      return { ...state, items: action.items }
    case 'CLEAR_RUN':
      return {
        ...initialState(),
        seenEventIds: new Set(),
      }
    case 'APPEND_EVENT': {
      const duplicate = state.seenEventIds.has(action.event.eventId)
      const events = duplicate
        ? state.events
        : [
            ...(state.events.length >= MAX_EVENTS
              ? state.events.slice(-(MAX_EVENTS - 1))
              : state.events),
            action.event,
          ]
      const terminalStatus = terminalStatusFromEvent(action.event)
      const appliedTerminalStatus = state.run?.id === action.event.runId
        ? terminalStatus
        : null
      const run = appliedTerminalStatus && state.run
        ? {
            ...state.run,
            status: appliedTerminalStatus,
            updatedAt: action.event.timestamp,
          }
        : state.run
      if (duplicate && run === state.run) return state
      return {
        ...state,
        run,
        events,
        seenEventIds: duplicate
          ? state.seenEventIds
          : new Set(events.map((event) => event.eventId)),
        isSubmitting: appliedTerminalStatus ? false : state.isSubmitting,
      }
    }
    case 'SET_EVENTS': {
      const events = action.events.slice(-MAX_EVENTS)
      return { ...state, events, seenEventIds: new Set(events.map((event) => event.eventId)) }
    }
    case 'APPEND_ITEM': {
      return {
        ...state,
        items: mergeConversationItems(state.items, [action.item]),
      }
    }
    case 'SET_SUBMITTING':
      return { ...state, isSubmitting: action.value }
    case 'SET_ERROR':
      return { ...state, uiError: action.error }
    case 'SET_INTENT':
      return { ...state, intent: action.intent }
    case 'SET_PLAN':
      return { ...state, agentWorkflow: action.plan }
    case 'APPEND_ARTIFACT':
      return {
        ...state,
        artifacts: state.artifacts.some((a) => a.artifactId === action.artifact.artifactId)
          ? state.artifacts
          : [...state.artifacts, action.artifact],
      }
    case 'SET_PLACE_RESOLUTION':
      return { ...state, placeResolution: action.placeResolution }
    default:
      return state
  }
}

const FINAL_RUN_STATUSES = new Set<AnalysisRun['status']>([
  'completed',
  'failed',
  'cancelled',
])

function mergeRunLifecycleProjection(
  current: AnalysisRun | undefined,
  incoming: AnalysisRun,
): AnalysisRun {
  if (!current || current.id !== incoming.id) return incoming
  if (incoming.updatedAt < current.updatedAt) return current
  if (FINAL_RUN_STATUSES.has(current.status) && !FINAL_RUN_STATUSES.has(incoming.status)) {
    return current
  }
  return incoming
}

function terminalStatusFromEvent(event: RunEvent): AnalysisRun['status'] | null {
  if (event.type === 'run.completed') return 'completed'
  if (event.type !== 'run.failed') return null
  return event.payload.cancelled === true ? 'cancelled' : 'failed'
}

// Hook 入口
//
// 对外暴露稳定命令函数；内部根据 runId 管理 WebSocket 订阅与快照回放。

export function useRunState() {
  const [state, dispatch] = useReducer(runReducer, undefined, initialState)
  const runId = state.run?.id
  const subscribedRunIdRef = useRef<string | null>(null)
  const projectionRunIdRef = useRef<string | null>(null)
  const liveProjectionRef = useRef<ConversationProjectionIndex | null>(null)

  const resetLiveProjection = useCallback((runId: string | null, items: ReadonlyArray<ConversationItem>) => {
    projectionRunIdRef.current = runId
    liveProjectionRef.current = new ConversationProjectionIndex(items, 'live')
    return liveProjectionRef.current.toArray()
  }, [])

  const appendLiveItem = useCallback((item: ConversationItem) => {
    if (!liveProjectionRef.current) {
      liveProjectionRef.current = new ConversationProjectionIndex([], 'live')
    }
    liveProjectionRef.current.upsert(item, 'live')
    dispatch({ type: 'SET_PROJECTED_ITEMS', items: liveProjectionRef.current.toArray() })
  }, [])

  const absorbSnapshot = useCallback((snapshot: { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }) => {
    const projectedItems = resetLiveProjection(snapshot.run.id, snapshot.items)
    dispatch({
      type: 'SET_RUN',
      run: snapshot.run,
      agentState: snapshot.run.state,
      intent: snapshot.run.state.parsedIntent ?? undefined,
      plan: snapshot.run.state.agentWorkflow ?? undefined,
      artifacts: snapshot.run.state.artifacts,
    })
    dispatch({ type: 'SET_PROJECTED_ITEMS', items: projectedItems })
    dispatch({ type: 'SET_EVENTS', events: snapshot.events })
    if (snapshot.run.status !== 'running') dispatch({ type: 'SET_SUBMITTING', value: false })
  }, [resetLiveProjection])

  const clearRun = useCallback(() => {
    projectionRunIdRef.current = null
    liveProjectionRef.current = null
    dispatch({ type: 'CLEAR_RUN' })
  }, [])

  const hydrateRun = useCallback(async (runId: string) => {
    const snapshot = await subscribeRun(runId)
    subscribedRunIdRef.current = runId
    absorbSnapshot(snapshot)
    return snapshot.run
  }, [absorbSnapshot])

  const acceptRun = useCallback((latestRun: AnalysisRun) => {
    if (projectionRunIdRef.current !== latestRun.id) {
      resetLiveProjection(latestRun.id, [])
    }
    dispatch({
      type: 'SET_RUN',
      run: latestRun,
      agentState: latestRun.state,
      intent: latestRun.state.parsedIntent ?? undefined,
      plan: latestRun.state.agentWorkflow ?? undefined,
      artifacts: latestRun.state.artifacts,
    })
  }, [resetLiveProjection])

  const startRun = useCallback(() => {
    dispatch({ type: 'SET_SUBMITTING', value: true })
  }, [])

  const stopSubmitting = useCallback(() => {
    dispatch({ type: 'SET_SUBMITTING', value: false })
  }, [])

  const finishRun = useCallback(async (runId: string) => {
    try {
      await hydrateRun(runId)
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
    } finally {
      dispatch({ type: 'SET_SUBMITTING', value: false })
    }
  }, [hydrateRun])

  const setError = useCallback((error?: string) => {
    dispatch({ type: 'SET_ERROR', error })
  }, [])

  const setIntent = useCallback((intent: UserIntent) => {
    dispatch({ type: 'SET_INTENT', intent })
  }, [])

  const setPlan = useCallback((plan: AgentWorkflow) => {
    dispatch({ type: 'SET_PLAN', plan })
  }, [])

  const appendArtifact = useCallback((artifact: ArtifactRef) => {
    dispatch({ type: 'APPEND_ARTIFACT', artifact })
  }, [])

  // WebSocket 订阅是运行实时状态的唯一主线；重连后主动重订阅并吸收完整快照。
  useEffect(() => {
    if (!runId) return
    let disposed = false

    const absorbCurrentSnapshot = (snapshot: { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] }) => {
      if (disposed || snapshot.run.id !== runId) return
      subscribedRunIdRef.current = runId
      absorbSnapshot(snapshot)
    }

    const unsubscribeMessages = wsClient.on(message => {
      if (message.type === 'connected') {
        void subscribeRun(runId).then(absorbCurrentSnapshot).catch(error => {
          if (!disposed) dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
        })
        return
      }
      if (message.type === 'run.item' && message.payload.data.runId === runId) {
        startTransition(() => appendLiveItem(message.payload.data))
      }
      if (message.type === 'run.event' && message.payload.data.runId === runId) {
        startTransition(() => dispatch({ type: 'APPEND_EVENT', event: message.payload.data }))
      }
      if (message.type === 'run.snapshot' && isRunSnapshot(message.payload.data) && message.payload.data.run.id === runId) {
        absorbCurrentSnapshot(message.payload.data)
      }
    })

    if (subscribedRunIdRef.current !== runId) {
      void subscribeRun(runId).then(absorbCurrentSnapshot).catch(error => {
        if (!disposed) dispatch({ type: 'SET_ERROR', error: formatHydrationError(error) })
      })
    }

    return () => {
      disposed = true
      unsubscribeMessages()
      if (subscribedRunIdRef.current === runId) subscribedRunIdRef.current = null
      void unsubscribeRun(runId).catch(error => {
        reportClientDiagnostic('warn', { scope: 'unsubscribeRun', error, detail: { runId } })
      })
    }
  }, [absorbSnapshot, appendLiveItem, runId])

  const setItems = useCallback((items: ConversationItem[]) => {
    resetLiveProjection(runId ?? null, items)
    dispatch({ type: 'SET_PROJECTED_ITEMS', items: liveProjectionRef.current?.toArray() ?? items })
  }, [resetLiveProjection, runId])

  return {
    run: state.run,
    agentState: state.agentState,
    intent: state.intent,
    agentWorkflow: state.agentWorkflow,
    events: state.events,
    artifacts: state.artifacts,
    isSubmitting: state.isSubmitting,
    uiError: state.uiError,
    placeResolution: state.placeResolution,
    clearRun,
    items: state.items,
    hydrateRun,
    acceptRun,
    startRun,
    finishRun,
    stopSubmitting,
    setError,
    setIntent,
    setPlan,
    appendArtifact,
    setItems,
  }
}


function isRunSnapshot(value: unknown): value is { run: AnalysisRun; items: ConversationItem[]; events: RunEvent[] } {
  return isRecord(value) && isRecord(value.run) && Array.isArray(value.items) && Array.isArray(value.events)
}
