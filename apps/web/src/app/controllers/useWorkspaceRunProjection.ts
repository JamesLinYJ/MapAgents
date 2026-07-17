// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 Run 投影协调器
//
//   文件:       useWorkspaceRunProjection.ts
// --------------------------------------------------------------------------

import { startTransition, useCallback } from 'react'
import type { AnalysisRun } from '@geo-agent-platform/shared-types'

import { pickPreferredArtifactId } from '../../features/artifacts/artifactSelection'
import { mergeThreadRuns } from '../derivedState'

type ListUpdater<T> = T[] | ((current: T[]) => T[])

export interface WorkspaceRunProjectionOptions {
  clearArtifacts: () => void
  clearCanonicalThreadItems: () => void
  clearRun: () => void
  hydrateRun: (runId: string) => Promise<AnalysisRun>
  setActiveThreadId: (threadId?: string) => void
  setModel: (model: string) => void
  setProvider: (provider: string) => void
  setSelectedArtifactId: (artifactId?: string) => void
  setThreadRuns: (value: ListUpdater<AnalysisRun>) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useWorkspaceRunProjection({
  clearArtifacts,
  clearCanonicalThreadItems,
  clearRun,
  hydrateRun,
  setActiveThreadId,
  setModel,
  setProvider,
  setSelectedArtifactId,
  setThreadRuns,
  setToolRunResult,
  syncUrl,
}: WorkspaceRunProjectionOptions) {
  const clearActiveRunState = useCallback(() => {
    clearRun()
    clearArtifacts()
    clearCanonicalThreadItems()
    setThreadRuns([])
    setToolRunResult(null)
    setActiveThreadId(undefined)
  }, [
    clearArtifacts,
    clearCanonicalThreadItems,
    clearRun,
    setActiveThreadId,
    setThreadRuns,
    setToolRunResult,
  ])

  const hydrateRunState = useCallback(async (runId: string) => {
    const latestRun = await hydrateRun(runId)
    startTransition(() => {
      setActiveThreadId(latestRun.threadId ?? undefined)
      setProvider(latestRun.modelProvider ?? 'openai_compatible')
      setModel(latestRun.modelName ?? '')
      setSelectedArtifactId(pickPreferredArtifactId(latestRun.state.artifacts))
      setThreadRuns(current => mergeThreadRuns(current, latestRun))
    })
    syncUrl(latestRun.sessionId, latestRun.id, latestRun.threadId ?? undefined)
    return latestRun
  }, [
    hydrateRun,
    setActiveThreadId,
    setModel,
    setProvider,
    setSelectedArtifactId,
    setThreadRuns,
    syncUrl,
  ])

  return { clearActiveRunState, hydrateRunState }
}
