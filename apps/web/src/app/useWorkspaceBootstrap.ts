// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区启动控制器
//
//   文件:       useWorkspaceBootstrap.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 负责首屏认证、workspace bootstrap、分享链接指针校验和 run/thread 恢复。
// AppShell 只消费认证结果，不直接编排启动阶段的请求瀑布。

import { useCallback, useEffect, useState } from 'react'
import type {
  AnalysisRun,
  AuthMe,
  ConversationItem,
  ThreadHistoryPage,
  WorkspaceBootstrapSnapshot,
} from '@geo-agent-platform/shared-types'

import { getAuthMe } from '../api/client'
import { formatUiError, retryAsync, transcriptEntriesToConversationItems } from './bootstrap'

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'error'

export interface WorkspaceBootstrapPointer {
  activeThreadId?: string
  activeRunId?: string
}

export function useWorkspaceBootstrap({
  applyProviders,
  clearActiveRunState,
  getThreadHistory,
  hydrateRunState,
  loadWorkspaceBootstrap,
  readWorkspacePointer,
  setActiveThreadId,
  setCanonicalThreadItems,
  setUiError,
  syncUrl,
}: {
  applyProviders: (providers: WorkspaceBootstrapSnapshot['providers']) => void
  clearActiveRunState: () => void
  getThreadHistory: (threadId: string, cursor?: string | null, limit?: number) => Promise<ThreadHistoryPage>
  hydrateRunState: (runId: string) => Promise<AnalysisRun>
  loadWorkspaceBootstrap: (sessionId?: string) => Promise<WorkspaceBootstrapSnapshot>
  readWorkspacePointer: () => WorkspaceBootstrapPointer
  setActiveThreadId: (threadId: string | undefined) => void
  setCanonicalThreadItems: (items: ConversationItem[]) => void
  setUiError: (message: string | undefined) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [authMe, setAuthMe] = useState<AuthMe | null>(null)
  const [authRefreshNonce, setAuthRefreshNonce] = useState(0)

  const retryAuth = useCallback(() => {
    setAuthStatus('checking')
    setAuthRefreshNonce(value => value + 1)
  }, [])

  const clearAuth = useCallback(() => {
    setAuthMe(null)
    setAuthStatus('unauthenticated')
  }, [])

  useEffect(() => {
    // 首屏只吸收一次 workspace bootstrap；thread 摘要足以校验本地指针。
    // 完整运行通过 run:subscribe 一次恢复，不能再展开 thread/run 请求瀑布。
    let disposed = false
    const searchParams = new URLSearchParams(window.location.search)
    const workspacePointer = readWorkspacePointer()
    const sharedSessionId = searchParams.get('session') ?? undefined
    const sharedThreadId = searchParams.get('thread') ?? undefined
    const sharedRunId = searchParams.get('run') ?? undefined
    // localStorage 仅作为 UI 选中提示，不决定会话归属。
    const hintedThreadId = sharedThreadId ?? workspacePointer.activeThreadId
    const hintedRunId = sharedRunId ?? workspacePointer.activeRunId

    void (async () => {
      try {
        const auth = await getAuthMe().catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('未登录') || message.includes('401')) return null
          throw error
        })
        if (!auth) {
          if (!disposed) setAuthStatus('unauthenticated')
          return
        }
        if (disposed) return
        setAuthMe(auth)
        setAuthStatus('authenticated')
        const snapshot = await retryAsync(() => loadWorkspaceBootstrap(sharedSessionId), 2, 300)
        if (disposed) return
        applyProviders(snapshot.providers)
        setUiError(undefined)

        const sessionRecord = snapshot.session
        const threadToRestore = hintedThreadId || undefined
        const runToRestore = hintedRunId || undefined
        const thread = threadToRestore
          ? snapshot.threads.find(item => item.id === threadToRestore)
          : undefined

        if (threadToRestore && !thread) {
          if (sharedThreadId) throw new Error('分享链接中的对话不属于当前会话。')
          clearActiveRunState()
          syncUrl(sessionRecord.id)
          return
        }

        if (thread) setActiveThreadId(thread.id)
        const preferredRunId = runToRestore ?? thread?.latestRunId ?? undefined
        if (!preferredRunId) {
          syncUrl(sessionRecord.id, undefined, thread?.id)
          return
        }

        try {
          const restoredRun = await hydrateRunState(preferredRunId)
          if (disposed) return
          const wrongSession = restoredRun.sessionId !== sessionRecord.id
          const wrongThread = Boolean(thread && restoredRun.threadId !== thread.id)
          if (wrongSession || wrongThread) throw new Error('运行记录不属于当前会话或对话。')
          if (restoredRun.threadId) {
            const history = await getThreadHistory(restoredRun.threadId, null, 200)
            if (disposed) return
            setCanonicalThreadItems(transcriptEntriesToConversationItems(history.entries))
          }
        } catch (error) {
          if (sharedRunId || sharedThreadId) throw error
          clearActiveRunState()
          syncUrl(sessionRecord.id)
        }
      } catch (error) {
        if (!disposed) {
          setAuthStatus('error')
          setUiError(formatUiError(error, '页面加载遇到问题，请刷新重试。'))
        }
      }
    })()

    return () => { disposed = true }
  }, [
    applyProviders,
    authRefreshNonce,
    clearActiveRunState,
    hydrateRunState,
    getThreadHistory,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setCanonicalThreadItems,
    setUiError,
    syncUrl,
  ])

  return { authMe, authStatus, clearAuth, retryAuth }
}
