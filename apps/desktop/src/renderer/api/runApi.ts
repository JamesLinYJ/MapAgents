// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Run API
//
//   文件:       runApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  type AgentExecutionMode,
  type AnalysisRun,
  type RunSnapshot,
  type RunSteeringRecord,
} from '@geo-agent-platform/shared-types'

import { requestControl } from './transport'

export function startAnalysis(
  sessionId: string,
  query: string,
  provider?: string,
  model?: string,
  executionMode: AgentExecutionMode = 'auto',
): Promise<AnalysisRun> {
  return requestControl('run:start', {
    sessionId,
    query,
    provider,
    modelName: model,
    executionMode,
  })
}

export function startThreadRun(
  threadId: string,
  query: string,
  provider?: string,
  model?: string,
  executionMode: AgentExecutionMode = 'auto',
): Promise<AnalysisRun> {
  return requestControl('run:start', {
    threadId,
    query,
    provider,
    modelName: model,
    executionMode,
  })
}

export async function getRun(runId: string): Promise<AnalysisRun> {
  const snapshot = await requestControl('run:get', { runId })
  return snapshot.run
}

export const getThreadRun = getRun

export async function getRunEvents(runId: string): Promise<RunSnapshot['events']> {
  const snapshot = await requestControl('run:get', { runId })
  return snapshot.events
}

export async function getRunItems(runId: string): Promise<RunSnapshot['items']> {
  const snapshot = await requestControl('run:get', { runId })
  return snapshot.items
}

export function respondDecision(
  runId: string,
  decisionId: string,
  optionId?: string | null,
  text?: string | null,
): Promise<AnalysisRun> {
  return requestControl('run:respond-decision', { runId, decisionId, optionId, text })
}

export function cancelRun(runId: string): Promise<AnalysisRun> {
  return requestControl('run:cancel', { runId })
}

export function steerRun(runId: string, content: string, steeringId: string): Promise<RunSteeringRecord> {
  return requestControl('run:steer', { runId, content, steeringId })
}

export function resumeRun(runId: string): Promise<AnalysisRun> {
  return requestControl('run:resume', { runId })
}

export function subscribeRun(runId: string): Promise<RunSnapshot> {
  return requestControl('run:subscribe', { runId })
}

export function unsubscribeRun(runId: string) {
  return requestControl('run:unsubscribe', { runId })
}
