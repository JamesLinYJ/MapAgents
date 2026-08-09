// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制面测试
//
//   文件:       subAgentControlPlane.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { subAgentStateSchema } from '../schemas/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { SubAgentControlPlane } from './subAgentControlPlane.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('SubAgentControlPlane', () => {
  it('queues and delivers follow-ups, then aborts only the selected Agent-as-tool invocation', async () => {
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store)
      const signal = controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_agent_1',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      const queued = await controls.followUp({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'follow_up_1',
        content: '请补充 CRS 证据。',
        createdByUserId: 'user_goal',
      })
      expect(queued.controls).toContainEqual(expect.objectContaining({
        controlId: 'follow_up_1',
        kind: 'follow_up',
        status: 'queued',
      }))

      const instructions = await controls.consumeInstructions(fixture.runId, 'spatial_analyst')
      expect(instructions).toEqual(['用户追加追问：请补充 CRS 证据。'])
      expect(fixture.store.getRun(fixture.runId).state.subAgents[0].controls[0].status).toBe('delivered')

      const cancelling = await controls.cancel({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'cancel_1',
        content: '改由主智能体处理。',
        createdByUserId: 'user_goal',
      })
      expect(cancelling.status).toBe('cancelling')
      expect(signal?.aborted).toBe(true)
      expect(fixture.store.getRun(fixture.runId).status).toBe('running')
      expect(await fixture.store.listEvents(fixture.runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'subagent.updated',
          payload: expect.objectContaining({ controlId: 'cancel_1', isolated: true }),
        }),
      ]))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('projects stalled state after an active child stops producing SDK activity', async () => {
    vi.useFakeTimers()
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store, 20, 20)
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_agent_stalled',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      await vi.advanceTimersByTimeAsync(25)

      expect(fixture.store.getRun(fixture.runId).state.subAgents[0]).toMatchObject({
        status: 'running',
        stalled: true,
        stalledSince: expect.any(String),
      })
      expect(await fixture.store.listEvents(fixture.runId)).toContainEqual(expect.objectContaining({
        message: '空间分析智能体 可能卡顿',
      }))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('arbitrates cancellation and completion to one callId terminal outcome', async () => {
    const fixture = await createFixture()
    try {
      const controls = new SubAgentControlPlane(fixture.store)
      controls.begin({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        callId: 'call_terminal_race',
        delegationMode: 'as_tool',
        timeoutMs: 120_000,
      })

      await controls.cancel({
        runId: fixture.runId,
        agentId: 'spatial_analyst',
        controlId: 'cancel_terminal_race',
        content: '停止当前检查。',
        createdByUserId: 'user_goal',
      })

      expect(controls.claimTerminalOutcome(
        fixture.runId,
        'spatial_analyst',
        'call_terminal_race',
      )).toEqual({ status: 'cancelled', reason: '停止当前检查。' })
      expect(() => controls.claimTerminalOutcome(
        fixture.runId,
        'spatial_analyst',
        'call_terminal_race',
      )).toThrow('已由其他终态处理')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-subagent-control-'))
  const store = createTestPersistenceFacade(root)
  await store.initialize()
  const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
  const thread = await store.createThread(session.id, '子智能体控制')
  const run = await store.createRun(session.id, '执行空间分析', {
    threadId: thread.id,
    modelProvider: 'fake',
  })
  await store.updateRunStatus(run.id, 'running')
  await store.updateRunState(run.id, {
    subAgents: [subAgentStateSchema.parse({
      agentId: 'spatial_analyst',
      name: '空间分析智能体',
      role: 'analyst',
      status: 'running',
      summary: '检查空间数据。',
      tools: ['query_layer'],
      stepIds: ['step_agent'],
      currentStepId: 'step_agent',
      activeCallId: 'call_agent_1',
    })],
  })
  return { root, store, runId: run.id }
}
