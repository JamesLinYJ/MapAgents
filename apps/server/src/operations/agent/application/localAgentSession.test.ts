// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机 Agent 会话控制器测试
//
//   文件:       localAgentSession.test.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'

import {
  analysisRunSchema,
  conversationItemSchema,
  runSnapshotSchema,
  workspaceBootstrapSnapshotSchema,
  type AnalysisRun,
  type WsControlCommand,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import type { LocalAgentPush } from '../transport/localAgentClient.js'
import {
  LocalAgentSession,
  type LocalAgentClientPort,
} from './localAgentSession.js'

describe('LocalAgentSession', () => {
  it('uses the server provider default without forwarding a host CLI model', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()

    await session.submit('杭州明天会下雨吗？')

    const start = client.requests.find(request => request.type === 'run:start')
    expect(start?.payload).toMatchObject({
      query: '杭州明天会下雨吗？',
      provider: 'deepseek',
      executionMode: 'auto',
    })
    expect(start?.payload).not.toHaveProperty('modelName')
    expect(session.snapshot().model).toBe('deepseek-v4-flash')
  })

  it('forwards an explicitly selected model only after provider capability validation', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({
      connectClient: async () => client,
      model: 'deepseek-v4-pro',
    })
    await session.initialize()

    await session.submit('分析杭州强降水风险')

    expect(client.requests.find(request => request.type === 'run:start')?.payload)
      .toMatchObject({ provider: 'deepseek', modelName: 'deepseek-v4-pro' })
  })

  it('rejects a model that is absent from the provider capability list before run creation', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({
      connectClient: async () => client,
      model: 'gpt-5.6-sol',
    })

    await expect(session.initialize()).rejects.toThrow('未通过本地能力预检')
    expect(client.requests.some(request => request.type === 'run:start')).toBe(false)
  })

  it('upserts cumulative streaming items by itemId instead of duplicating text', async () => {
    const client = new TestClient()
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('你好')

    client.push(itemPush('答'))
    client.push(itemPush('答案'))

    await vi.waitFor(() => {
      expect(session.snapshot().items).toHaveLength(1)
      expect(session.snapshot().items[0]?.body).toBe('答案')
    })
  })

  it('switches to the new run returned by a clarification response', async () => {
    const client = new TestClient()
    const waiting = run('run_waiting', 'clarification_needed')
    waiting.state.decisions = [{
      decisionId: 'decision_place',
      kind: 'clarification',
      title: '补充地点',
      question: '请问是哪个城市？',
      description: '',
      options: [],
      allowFreeText: true,
      status: 'pending',
      payload: {},
      createdAt: '2026-07-27T00:00:00.000Z',
      resolvedAt: null,
    }]
    client.startRun = waiting
    const next = run('run_next', 'running')
    client.decisionRun = next
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('明天会下雨吗？')

    await session.respondDecision({ decisionId: 'decision_place', text: '杭州' })

    expect(session.snapshot().run?.id).toBe('run_next')
    expect(client.requests.at(-1)).toMatchObject({
      type: 'run:respond-decision',
      payload: { runId: 'run_waiting', decisionId: 'decision_place', text: '杭州' },
    })
  })

  it('does not orphan a running or decision-waiting run when starting a new conversation', async () => {
    const client = new TestClient()
    client.startRun = run('run_waiting', 'waiting_approval')
    const session = new LocalAgentSession({ connectClient: async () => client })
    await session.initialize()
    await session.submit('执行受保护任务')

    expect(() => session.newConversation()).toThrow('当前运行尚未结束')
    expect(session.snapshot().run?.id).toBe('run_waiting')
    expect(session.snapshot().threadId).toBe('thread_1')
  })
})

class TestClient implements LocalAgentClientPort {
  readonly events = new EventEmitter()
  readonly requests: Array<{ type: WsControlCommand; payload: Record<string, unknown> }> = []
  startRun = run('run_1', 'running')
  decisionRun = this.startRun

  async send<T>(
    type: WsControlCommand,
    payload: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.requests.push({ type, payload })
    const value: unknown = type === 'workspace:bootstrap'
      ? bootstrap()
      : type === 'run:start'
        ? this.startRun
        : type === 'run:respond-decision'
          ? this.decisionRun
          : type === 'run:subscribe' || type === 'run:get'
            ? runSnapshotSchema.parse({ run: this.startRun, items: [], events: [] })
            : this.startRun
    return schema.parse(value)
  }

  onPush(listener: (message: LocalAgentPush) => void): () => void {
    this.events.on('push', listener)
    return () => this.events.off('push', listener)
  }

  onDisconnected(listener: (error: Error) => void): () => void {
    this.events.on('disconnected', listener)
    return () => this.events.off('disconnected', listener)
  }

  push(message: LocalAgentPush): void {
    this.events.emit('push', message)
  }

  close(): void {}
}

function bootstrap() {
  return workspaceBootstrapSnapshotSchema.parse({
    auth: {
      user: {
        userId: 'platform_local_agent',
        subject: 'auth_local_agent',
        email: 'agent@local-agent.geoforge.invalid',
        displayName: 'GeoForge Local Agent',
        status: 'active',
        lastLoginAt: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
      defaultWorkspace: null,
      memberships: [],
      platformRoles: ['platform_admin'],
      csrfToken: 'csrf',
      permissions: [],
    },
    session: {
      id: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'platform_local_agent',
      visibility: 'private',
      createdAt: '2026-07-27T00:00:00.000Z',
      status: 'active',
      shareToken: 'not-public',
    },
    threads: [],
    providers: [{
      provider: 'deepseek',
      displayName: 'DeepSeek',
      configured: true,
      defaultModel: 'deepseek-v4-flash',
      availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      capabilities: ['agents_sdk_live_supervisor'],
      agentRuntime: {
        transport: 'deepseek_chat_completions',
        structuredOutput: 'json_object',
        functionTools: true,
        localMcp: true,
        hostedTools: false,
        handoffs: true,
        multiToolResponse: true,
        providerParallelToolControl: false,
        remoteConversation: false,
        serverCompaction: false,
      },
      contextWindowTokens: 1_000_000,
    }],
    tools: [],
  })
}

function run(id: string, status: AnalysisRun['status']): AnalysisRun {
  return analysisRunSchema.parse({
    id,
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    userQuery: '测试',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    },
  })
}

function itemPush(body: string): LocalAgentPush {
  return {
    type: 'run.item',
    id: null,
    payload: {
      data: conversationItemSchema.parse({
        itemId: 'item_answer',
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body,
        status: 'running',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
    },
  }
}
