// +-------------------------------------------------------------------------
//
//   地理智能平台 - Goal 独立验收器测试
//
//   文件:       goalJudge.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelCompletionService } from '../model/modelResultCache.js'
import { toolCallSchema } from '../schemas/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { GoalJudge } from './goalJudge.js'

describe('GoalJudge', () => {
  it('uses a separate structured call over canonical evidence and records its usage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 验收')
      const run = await store.createRun(session.id, '检查图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: '检查图层并提供可验证结论。' },
      })
      await store.updateRunState(run.id, {
        toolResults: [toolCallSchema.parse({
          stepId: 'step_check',
          tool: 'query_layer',
          status: 'completed',
          message: '已读取 12 个要素。',
          resultId: 'result_layer_check',
        })],
      })
      let capturedRequest: Record<string, unknown> | null = null
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '工具账本证明图层已查询。',
        evidence: [{
          source: 'tool_result',
          referenceId: 'result_layer_check',
          statement: '查询成功返回 12 个要素。',
        }],
        missingCriteria: [],
      }, request => { capturedRequest = request }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      const verdict = await judge.evaluate({
        runId: run.id,
        threadId: thread.id,
        provider: 'fake',
        goal,
      })

      expect(verdict).toMatchObject({ status: 'satisfied', attempt: 1, tokenUsage: 12 })
      expect(capturedRequest).toMatchObject({
        runId: run.id,
        purpose: 'goal_judgement',
        cacheMode: 'bypass',
      })
      expect(String(capturedRequest?.prompt)).toContain('<canonical-evidence>')
      expect(String(capturedRequest?.prompt)).toContain('result_layer_check')
      expect(store.getRun(run.id).state.runtimeStats.modelTotalTokens).toBe(12)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects satisfied verdicts supported only by the working assistant text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-self-report-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 主观总结')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const assistant = await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'assistant', content: '我已经完成了所有工作。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '助手说已完成。',
        evidence: [{ source: 'transcript', referenceId: assistant.entryId, statement: '助手声称已完成。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow('不能只引用用户请求或工作 Agent 的助手文本')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat the current user request as proof that the goal was completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-user-request-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 用户请求不是证据')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const request = await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: '请完成图层检查。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '用户要求完成。',
        evidence: [{ source: 'transcript', referenceId: request.entryId, statement: '用户提出了要求。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow('不能只引用用户请求或工作 Agent 的助手文本')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects hallucinated evidence references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-reference-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 引用')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'impossible',
        reason: '数据不存在。',
        evidence: [{ source: 'tool_result', referenceId: 'invented_result', statement: '伪造引用。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow("不存在的 tool_result 证据 'invented_result'")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects evidence references from an earlier run in the same thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-run-scope-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 运行证据隔离')
      const earlierRun = await store.createRun(session.id, '上一次分析', {
        threadId: thread.id,
        modelProvider: 'fake',
      })
      const earlierEvidence = await store.appendTranscript({
        threadId: thread.id,
        runId: earlierRun.id,
        kind: 'checkpoint',
        payload: { type: 'verified_result', content: '旧运行的分析结果。' },
      })
      const currentRun = await store.createRun(session.id, '当前分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: currentRun.id,
        kind: 'message',
        payload: { role: 'user', content: '请重新检查当前数据。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '旧运行已经完成。',
        evidence: [{
          source: 'transcript',
          referenceId: earlierEvidence.entryId,
          statement: '引用了上一次运行的证据。',
        }],
        missingCriteria: [],
      }))
      const goal = store.getRun(currentRun.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({
        runId: currentRun.id,
        threadId: thread.id,
        provider: 'fake',
        goal,
      })).rejects.toThrow(`不存在的 transcript 证据 '${earlierEvidence.entryId}'`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function goalInput() {
  return {
    condition: '图层已完成检查并有客观证据。',
    acceptanceCriteria: ['至少有一条工具或 Artifact 证据。'],
    maxRechecks: 2,
    deadlineAt: null,
    maxTokenBudget: 1000,
  }
}

function fakeCompletions(
  decision: Record<string, unknown>,
  capture?: (request: Record<string, unknown>) => void,
): Pick<ModelCompletionService, 'completeStructured'> {
  const completeStructured: ModelCompletionService['completeStructured'] = async (request, schema) => {
    capture?.(request as unknown as Record<string, unknown>)
    return {
      content: schema.parse(decision),
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 10,
        cacheDetailReported: 1,
      },
      resultCache: 'bypass',
    }
  }
  return { completeStructured }
}
