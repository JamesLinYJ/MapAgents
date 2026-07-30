// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化契约测试
//
//   文件:       resultPersistence.test.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { persistToolExecutionResult } from './resultPersistence.js'

describe('tool result persistence', () => {
  it('preserves all results from concurrent tool completions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-concurrent-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行结果测试')
      const run = await store.createRun(session.id, '并行执行工具', { threadId: thread.id })

      await Promise.all(['tool_a', 'tool_b'].map(tool => persistToolExecutionResult(
        store!, run.id, tool, tool, {}, {
          message: `${tool} 完成`,
          payload: {},
          warnings: [],
          resultId: `result_${tool}`,
          source: 'test',
        },
      )))

      expect(store.getRun(run.id).state.toolResults.map(result => result.tool).sort())
        .toEqual(['tool_a', 'tool_b'])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists inline GeoJSON identically for direct and agent tool paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '结果测试')
      const run = await store.createRun(session.id, '执行工具', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'route_planner', '路径规划', {}, {
        message: '路线完成',
        payload: { route: line() },
        warnings: [],
        resultId: 'result_route',
        source: 'test',
        valueRefs: [{ refId: 'ref_route', kind: 'route', label: '路线', value: line() }],
      })

      const latest = store.getRun(run.id)
      expect(latest.state.artifacts).toHaveLength(1)
      expect(latest.state.toolValueRefs[0].refId).toBe('ref_route')
      expect(latest.state.toolResults[0]?.toolLabel).toBe('路径规划')
      const relativePath = String(latest.state.artifacts[0].metadata.relativePath)
      expect(JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))).toEqual(line())
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists todo_write payload into AgentState.todos', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Todo 测试')
      const run = await store.createRun(session.id, '执行 Todo', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'todo_write', '更新任务清单', {}, {
        message: '已更新 Todo',
        payload: {
          todos: [
            { todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' },
            { todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' },
          ],
        },
        warnings: [],
        resultId: 'result_todo',
        source: 'test',
      })

      expect(store.getRun(run.id).state.todos).toEqual([
        expect.objectContaining({ todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' }),
        expect.objectContaining({ todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' }),
      ])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists request_clarification payload as a pending DecisionRequest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-clarification-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '澄清测试')
      const run = await store.createRun(session.id, '要画图', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'request_clarification', '请求澄清', {}, {
        message: '需要确认平台',
        payload: {
          clarification: {
            clarificationId: 'clarification_platform',
            kind: 'platform',
            reason: '缺少目标平台',
            question: '目标平台是什么？',
            allowFreeText: true,
            options: [
              { optionId: 'browser', label: '浏览器 WebGL', description: '在浏览器中运行' },
            ],
          },
        },
        warnings: [],
        resultId: 'result_clarification',
        source: 'test',
      })

      const latest = store.getRun(run.id)
      expect(latest.state.clarification).toMatchObject({
        clarificationId: 'clarification_platform',
        question: '目标平台是什么？',
        selectedOptionId: null,
      })
      expect(latest.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: 'clarification_platform',
        kind: 'clarification',
        title: '需要补充信息',
        question: '目标平台是什么？',
        status: 'pending',
        allowFreeText: true,
        payload: expect.objectContaining({ clarificationKind: 'platform' }),
      }))
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function line() {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120, 30], [121, 31]] } }
}
