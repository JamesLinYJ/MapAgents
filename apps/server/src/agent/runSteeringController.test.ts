// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行引导控制器测试
//
//   文件:       runSteeringController.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { PersistenceFacadeTestHarness } from '../../test-support/persistenceFacadeHarness.js'
import {
  completeAgentWorkflowStep,
  createAgentWorkflow,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'
import { RunSteeringController } from './runSteeringController.js'

describe('RunSteeringController', () => {
  it('queues idempotently, consumes in order, and rejects new input after close', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行中引导')
      const run = await store.createRun(session.id, '先分析数据', { threadId: thread.id })
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)

      await controller.open(run.id)
      const first = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      const retry = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      expect(retry).toEqual(first)
      expect((await store.listRunInputs(run.id))).toHaveLength(1)

      const consumed = await controller.consumePending(run.id)
      expect(consumed).toEqual([{
        type: 'message',
        role: 'user',
        content: '重点检查最近三十分钟',
      }])
      expect((await store.listRunInputs(run.id))[0]?.status).toBe('consumed')
      expect((await store.activeTranscript(thread.id)).at(-1)?.payload.content).toBe('重点检查最近三十分钟')
      const steeringItem = (await store.listItems(run.id)).find(item => item.itemId === first.itemId)
      expect(steeringItem?.metadata).toMatchObject({
        steeringId: first.steeringId,
        transcriptEntryId: first.entryId,
      })
      expect(steeringItem?.metadata).not.toHaveProperty('steeringEntryId')

      await controller.close(run.id)
      await expect(controller.enqueue(run.id, 'steer_2', '再检查空间范围'))
        .rejects.toThrow('已结束接收引导消息')
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('advances one durable objective revision per unique input and invalidates completed workflow evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-revision-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行输入 revision')
      const run = await store.createRun(session.id, '先完成旧目标', {
        threadId: thread.id,
        goal: {
          condition: '交付当前输入对应的结论',
          acceptanceCriteria: ['结论覆盖当前输入'],
          maxRechecks: 2,
          deadlineAt: null,
          maxTokenBudget: null,
        },
      })
      const draft = {
        goal: '交付旧输入结论',
        steps: [{
          stepId: 'deliver',
          title: '交付结论',
          kind: 'delivery' as const,
          phase: 'deliver' as const,
          toolName: 'deliver_result',
          ownerAgentId: 'supervisor',
          args: {},
          reason: '完成旧输入',
          dependsOn: [],
        }],
      }
      const runningWorkflow = startAgentWorkflowStep(
        createAgentWorkflow(draft, 1),
        { stepId: 'deliver' },
      )
      const completedWorkflow = completeAgentWorkflowStep(
        runningWorkflow,
        { stepId: 'deliver', resultSummary: '旧输入已完成' },
      )
      await store.updateRunState(run.id, {
        agentWorkflow: completedWorkflow,
        goal: run.state.goal && {
          ...run.state.goal,
          status: 'satisfied',
          lastVerdict: {
            status: 'satisfied',
            reason: '旧输入已满足',
            evidence: [{ source: 'workflow', referenceId: completedWorkflow.agentWorkflowId, statement: '旧工作流完成' }],
            missingCriteria: [],
            attempt: 1,
            evaluatedAt: new Date().toISOString(),
            tokenUsage: 1,
          },
        },
      })
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)
      await controller.open(run.id)

      expect(await controller.consumedObjectiveRevision(run.id)).toBe(1)
      await controller.enqueue(run.id, 'steer_revision', '新增核验范围')
      await controller.enqueue(run.id, 'steer_revision', '新增核验范围')

      const advanced = store.getRun(run.id).state
      expect(advanced.objectiveRevision).toBe(2)
      expect(advanced.goal).toMatchObject({
        objectiveRevision: 2,
        status: 'active',
        recheckCount: 0,
        lastVerdict: null,
        completedAt: null,
      })
      expect(advanced.agentWorkflow).toMatchObject({
        objectiveRevision: 2,
        revision: 1,
        status: 'adjusting',
        completedAt: null,
      })

      let staleCommitRan = false
      expect(await controller.commitRevision(run.id, 1, async () => {
        staleCommitRan = true
      })).toBe(false)
      expect(staleCommitRan).toBe(false)
      expect(await controller.tryClaimTerminal(run.id, 1)).toBe(false)

      await controller.consumePending(run.id)
      expect(await controller.consumedObjectiveRevision(run.id)).toBe(2)
      expect(await controller.stateForRevision(run.id, 2)).toMatchObject({ objectiveRevision: 2 })
      expect(await controller.tryClaimTerminal(run.id, 2)).toBe(true)
      await expect(controller.enqueue(run.id, 'steer_after_claim', '终态 flush 期间的新输入'))
        .rejects.toThrow('已结束接收引导消息')
      await controller.close(run.id)
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
