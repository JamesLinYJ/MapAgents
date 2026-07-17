// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 生命周期动作
//
//   文件:       useRunLifecycleActions.ts
// --------------------------------------------------------------------------

import { startTransition, useCallback } from 'react'
import type {
  AgentExecutionMode,
  AnalysisRun,
  ConversationItem,
  ModelProviderDescriptor,
  SessionRecord,
} from '@geo-agent-platform/shared-types'

import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'
import { projectTimeline } from '../../features/conversation/timelineProjector'
import { formatUiError, reportNonBlockingError } from '../bootstrap'
import { mergeThreadRuns } from '../derivedState'
import type { PanelMode, PrimaryNav, SidebarItemId } from '../types'

type ListUpdater<T> = T[] | ((current: T[]) => T[])

export interface RunLifecycleOptions {
  session?: SessionRecord
  currentThreadId?: string | null
  query: string
  items: ConversationItem[]
  providers: ModelProviderDescriptor[]
  provider: string
  model: string
  run?: AnalysisRun
  acceptRun: (run: AnalysisRun) => void
  cancelRun: (runId: string) => Promise<AnalysisRun>
  clearArtifacts: () => void
  clearCanonicalThreadItems: () => void
  hydrateRunState: (runId: string) => Promise<AnalysisRun>
  refreshCanonicalThreadHistory: (threadId: string) => Promise<unknown>
  refreshSessionHistory: (sessionId: string) => Promise<unknown>
  respondDecision: (
    runId: string,
    decisionId: string,
    optionId?: string | null,
    text?: string | null,
  ) => Promise<AnalysisRun>
  steerRun: (runId: string, content: string, steeringId: string) => Promise<unknown>
  setActiveNav: (nav: PrimaryNav) => void
  setActiveThreadId: (threadId?: string) => void
  setActiveSidebarItem: (item: SidebarItemId) => void
  setCanonicalThreadItems: (threadId: string, value: ListUpdater<ConversationItem>) => void
  setModel: (model: string) => void
  setPanelMode: (mode: PanelMode) => void
  setProvider: (provider: string) => void
  setQuery: (query: string) => void
  setThreadRuns: (value: ListUpdater<AnalysisRun>) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  setUiError: (message?: string) => void
  startAnalysis: (
    sessionId: string,
    query: string,
    provider?: string,
    model?: string,
    executionMode?: AgentExecutionMode,
  ) => Promise<AnalysisRun>
  startRun: () => void
  startThreadRun: (
    threadId: string,
    query: string,
    provider?: string,
    model?: string,
    executionMode?: AgentExecutionMode,
  ) => Promise<AnalysisRun>
  stopSubmitting: () => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useRunLifecycleActions(options: RunLifecycleOptions) {
  const {
    session,
    currentThreadId,
    query,
    items,
    providers,
    provider,
    model,
    run,
    acceptRun,
    cancelRun,
    clearArtifacts,
    clearCanonicalThreadItems,
    hydrateRunState,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    steerRun,
    setActiveNav,
    setActiveThreadId,
    setActiveSidebarItem,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    stopSubmitting,
    syncUrl,
  } = options

  const submitMessage = useCallback(async ({
    text,
    forceNewThread = false,
    executionMode = 'auto',
  }: {
    text?: string
    forceNewThread?: boolean
    executionMode?: AgentExecutionMode
  } = {}) => {
    if (!session) return
    const submittedQuery = (text ?? query).trim()
    if (!submittedQuery) return

    if (!forceNewThread && run?.status === 'running') {
      try {
        setUiError(undefined)
        await steerRun(run.id, submittedQuery, `steer_${crypto.randomUUID()}`)
        setQuery('')
      } catch (error) {
        setUiError(formatUiError(error, '引导消息提交失败，请重试。'))
      }
      return
    }

    const targetThreadId = forceNewThread ? undefined : currentThreadId
    try {
      const selectedProvider = providers.find(item => item.provider === provider)
      if (selectedProvider && !selectedProvider.configured) {
        setUiError(`${selectedProvider.displayName} 还没配置好，暂时没法提交分析。`)
        return
      }
      if (selectedProvider && !supportsAgentSdkLiveSupervisor(selectedProvider)) {
        setUiError(`${selectedProvider.displayName} 当前不是 Agent SDK 主路径，不能提交分析。`)
        return
      }

      setUiError(undefined)
      startRun()
      setActiveNav('analysis')
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      if (forceNewThread) {
        clearArtifacts()
        setToolRunResult(null)
        clearCanonicalThreadItems()
      } else if (targetThreadId) {
        setCanonicalThreadItems(targetThreadId, current => projectTimeline(
          current,
          items.filter(item => item.status !== 'running' && [
            'message', 'function_call', 'function_call_output',
          ].includes(item.itemType)),
        ))
      }

      const createdRun = targetThreadId
        ? await startThreadRun(targetThreadId, submittedQuery, provider, model || undefined, executionMode)
        : await startAnalysis(session.id, submittedQuery, provider, model || undefined, executionMode)
      setQuery('')
      const nextThreadId = createdRun.threadId ?? targetThreadId
      startTransition(() => {
        acceptRun(createdRun)
        setProvider(createdRun.modelProvider ?? provider)
        setModel(createdRun.modelName ?? model)
        setActiveThreadId(nextThreadId ?? undefined)
        setThreadRuns(current => (nextThreadId && !forceNewThread
          ? mergeThreadRuns(current, createdRun)
          : [createdRun]))
      })
      void refreshSessionHistory(session.id).catch(error => {
        reportNonBlockingError('refreshSessionHistory:submitMessage', error)
      })
      syncUrl(session.id, createdRun.id, nextThreadId ?? undefined)
    } catch (error) {
      setUiError(formatUiError(error, '任务提交失败，请重试。'))
      stopSubmitting()
    }
  }, [
    acceptRun,
    clearArtifacts,
    clearCanonicalThreadItems,
    currentThreadId,
    items,
    model,
    provider,
    providers,
    query,
    refreshSessionHistory,
    run?.id,
    run?.status,
    session,
    setActiveNav,
    setActiveSidebarItem,
    setActiveThreadId,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    steerRun,
    stopSubmitting,
    syncUrl,
  ])

  const handleSubmit = useCallback(async (executionMode: AgentExecutionMode = 'auto') => {
    if (!query.trim()) return
    await submitMessage({ executionMode })
  }, [query, submitMessage])

  const handleInterruptRun = useCallback(async () => {
    if (!run?.id) {
      stopSubmitting()
      return
    }
    try {
      setUiError(undefined)
      const cancelledRun = await cancelRun(run.id)
      acceptRun(cancelledRun)
      if (cancelledRun.sessionId) {
        void refreshSessionHistory(cancelledRun.sessionId).catch(error => {
          reportNonBlockingError('refreshSessionHistory:cancelRun', error)
        })
      }
    } catch (error) {
      setUiError(formatUiError(error, '中断运行失败，请稍后再试。'))
    } finally {
      stopSubmitting()
    }
  }, [acceptRun, cancelRun, refreshSessionHistory, run?.id, setUiError, stopSubmitting])

  const handleRespondDecision = useCallback(async (
    decisionId: string,
    optionId?: string | null,
    text?: string | null,
  ) => {
    if (!run?.id) return
    let decisionSubmitted = false
    try {
      setUiError(undefined)
      startRun()
      const nextRun = await respondDecision(run.id, decisionId, optionId, text)
      decisionSubmitted = true
      const nextThreadId = nextRun.threadId ?? currentThreadId
      if (nextThreadId) await refreshCanonicalThreadHistory(nextThreadId)
      startTransition(() => {
        acceptRun(nextRun)
        setProvider(nextRun.modelProvider ?? provider)
        setModel(nextRun.modelName ?? model)
        setActiveThreadId(nextThreadId ?? undefined)
        setThreadRuns(current => (nextThreadId ? mergeThreadRuns(current, nextRun) : current))
      })
      if (nextRun.sessionId) {
        void refreshSessionHistory(nextRun.sessionId).catch(error => {
          reportNonBlockingError('refreshSessionHistory:respondDecision', error)
        })
      }
      syncUrl(nextRun.sessionId, nextRun.id, nextThreadId ?? undefined)
      await hydrateRunState(nextRun.id)
    } catch (error) {
      if (decisionSubmitted) {
        reportNonBlockingError('hydrateConversation:respondDecision', error)
        setUiError('决策已经提交，但完整对话历史恢复失败。请刷新页面重新加载记录，不要重复提交决策。')
      } else {
        setUiError(formatUiError(error, '决策提交失败，请重试。'))
      }
      stopSubmitting()
    }
  }, [
    acceptRun,
    currentThreadId,
    hydrateRunState,
    model,
    provider,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    run?.id,
    setActiveThreadId,
    setModel,
    setProvider,
    setThreadRuns,
    setUiError,
    startRun,
    stopSubmitting,
    syncUrl,
  ])

  return { handleInterruptRun, handleRespondDecision, handleSubmit, submitMessage }
}
