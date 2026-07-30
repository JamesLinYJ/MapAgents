// +-------------------------------------------------------------------------
//
//   地理智能平台 - 直接工具执行动作
//
//   文件:       useToolExecutionAction.ts
// --------------------------------------------------------------------------

import { useCallback } from 'react'
import type { DirectToolRunResponse, ToolDescriptor } from '@geo-agent-platform/shared-types'

import { formatUiError } from '../bootstrap'

export interface ToolExecutionActionOptions {
  sessionId?: string
  threadId?: string | null
  runId?: string
  hydrateRunState: (runId: string) => Promise<unknown>
  runTool: (payload: Record<string, unknown>) => Promise<DirectToolRunResponse>
  setIsToolSubmitting: (isSubmitting: boolean) => void
  setToolRunResult: (result: Record<string, unknown> | null) => void
  setUiError: (message?: string) => void
  syncUrl: (sessionId: string, runId?: string, threadId?: string) => void
}

export function useToolExecutionAction({
  sessionId,
  threadId,
  runId,
  hydrateRunState,
  runTool,
  setIsToolSubmitting,
  setToolRunResult,
  setUiError,
  syncUrl,
}: ToolExecutionActionOptions) {
  return useCallback(async (tool: ToolDescriptor, args: Record<string, unknown>) => {
    if (!sessionId) return

    try {
      setUiError(undefined)
      setIsToolSubmitting(true)
      const response = await runTool({
        sessionId,
        threadId,
        runId,
        toolName: tool.name,
        toolKind: tool.toolKind,
        args,
      })
      setToolRunResult(response)
      await hydrateRunState(response.run.id)
      syncUrl(sessionId, response.run.id, threadId ?? undefined)
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 执行失败。`))
    } finally {
      setIsToolSubmitting(false)
    }
  }, [
    hydrateRunState,
    runId,
    runTool,
    sessionId,
    setIsToolSubmitting,
    setToolRunResult,
    setUiError,
    syncUrl,
    threadId,
  ])
}
