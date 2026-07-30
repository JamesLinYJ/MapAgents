// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Run API
//
//   文件:       runApi.ts
// --------------------------------------------------------------------------

import {
  analysisRunSchema,
  runSteeringRecordSchema,
  runSnapshotSchema,
  type AgentExecutionMode,
  type AnalysisRun,
  type RunSnapshot,
  type RunSteeringRecord,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import { requestControl } from './transport'

const unsubscribedRunSchema = z.object({ unsubscribed: z.boolean(), runId: z.string() })

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
  }, analysisRunSchema)
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
  }, analysisRunSchema)
}

export async function getRun(runId: string): Promise<AnalysisRun> {
  const snapshot = await requestControl('run:get', { runId }, runSnapshotSchema)
  return snapshot.run
}

export const getThreadRun = getRun

export async function getRunEvents(runId: string): Promise<RunSnapshot['events']> {
  const snapshot = await requestControl('run:get', { runId }, runSnapshotSchema)
  return snapshot.events
}

export async function getRunItems(runId: string): Promise<RunSnapshot['items']> {
  const snapshot = await requestControl('run:get', { runId }, runSnapshotSchema)
  return snapshot.items
}

export function respondDecision(
  runId: string,
  decisionId: string,
  optionId?: string | null,
  text?: string | null,
): Promise<AnalysisRun> {
  return requestControl('run:respond-decision', { runId, decisionId, optionId, text }, analysisRunSchema)
}

export function cancelRun(runId: string): Promise<AnalysisRun> {
  return requestControl('run:cancel', { runId }, analysisRunSchema)
}

export function steerRun(runId: string, content: string, steeringId: string): Promise<RunSteeringRecord> {
  return requestControl('run:steer', { runId, content, steeringId }, runSteeringRecordSchema)
}

export function resumeRun(runId: string): Promise<AnalysisRun> {
  return requestControl('run:resume', { runId }, analysisRunSchema)
}

export function subscribeRun(runId: string): Promise<RunSnapshot> {
  return requestControl('run:subscribe', { runId }, runSnapshotSchema)
}

export function unsubscribeRun(runId: string): Promise<z.infer<typeof unsubscribedRunSchema>> {
  return requestControl('run:unsubscribe', { runId }, unsubscribedRunSchema)
}
