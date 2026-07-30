// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 中文本机 Agent 终端测试
//
//   文件:       localAgentConsole.test.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import { stripVTControlCharacters } from 'node:util'

import {
  analysisRunSchema,
  conversationItemSchema,
  workspaceBootstrapSnapshotSchema,
  type AgentExecutionMode,
  type AnalysisRun,
  type DecisionRequest,
} from '@geo-agent-platform/shared-types'
import { ThemeProvider } from '@inkjs/ui'
import { cleanup, render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { geoForgeConsoleTheme } from '../../localConsoleTheme.js'
import type { TerminalMouseEvent, TerminalMouseSource } from '../../terminalMouse.js'
import type { LocalAgentSessionSnapshot } from '../application/localAgentSession.js'
import {
  LocalAgentConsoleApp,
  type LocalAgentConsoleIdentity,
  type LocalAgentConsoleSession,
} from './localAgentConsole.js'

afterEach(() => cleanup())

describe('LocalAgentConsoleApp', () => {
  it.each([
    [80, 'GEOFORGE'],
    [100, '输入消息'],
    [140, '运行检查器'],
    [180, '本次运行尚未生成工作流'],
  ])('renders a stable high-density layout at %i columns', async (columns, expected) => {
    const instance = renderConsole(new TestSession(snapshot()))
    resize(instance.stdout, columns, 36)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain(expected)
      assertFrameFits(instance.lastFrame(), columns, 36)
    })
  })

  it('pauses rendering below 80x24 without corrupting the viewport', async () => {
    const instance = renderConsole(new TestSession(snapshot()))
    resize(instance.stdout, 79, 23)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('终端尺寸不足'))
    expect(instance.lastFrame()).toContain('至少需要 80×24')
    assertFrameFits(instance.lastFrame(), 79, 23)
  })

  it('treats ordinary letters as input and supports cursor-aware insertion', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('天气')
    instance.stdin.write('\u001b[D')
    instance.stdin.write('好')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('天好气'))
    expect(session.close).not.toHaveBeenCalled()

    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledWith('天好气'))
  })

  it('opens and filters the slash-command menu, then completes and executes an exact command', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('斜杠命令')
      expect(frame).toContain('/help')
      expect(frame).toContain('Tab/Enter 补全')
    })

    instance.stdin.write('st')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('/status')
      expect(frame).toContain('查看运行与连接状态')
      expect(frame).not.toContain('打开快捷键与命令帮助')
    })

    instance.stdin.write('\r')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /status'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('等待输入 · 已连接'))
    expect(session.submit).not.toHaveBeenCalled()
  })

  it('supports arrow selection and Tab completion in the slash-command menu', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('斜杠命令'))
    instance.stdin.write('\u001b[B')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /new'))
    instance.stdin.write('\t')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /new'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.newConversation).toHaveBeenCalledOnce())
  })

  it('scrolls the slash-command window so every registered command remains selectable', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('斜杠命令'))
    instance.stdin.write('\u001b[A')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('13/13')
      expect(frame).toContain('› /exit')
      expect(frame).not.toContain('打开快捷键与命令帮助')
      assertFrameFits(instance.lastFrame(), 100, 32)
    })
  })

  it('shows reasoning and assistant updates as canonical accumulated items', async () => {
    const value = snapshot(run('running'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'reasoning_1',
        itemType: 'reasoning',
        runId: 'run_1',
        threadId: 'thread_1',
        body: '先核验时次与地点，再读取降水数据。',
        status: 'running',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
      conversationItemSchema.parse({
        itemId: 'answer_1',
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: '正在整理杭州天气结论。',
        status: 'running',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 140, 36)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('先核验时次与地点')
      expect(instance.lastFrame()).toContain('正在整理杭州天气结论')
    })
  })

  it('shows a labelled reasoning activity even when motion is reduced', async () => {
    const value = snapshot(run('running'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'reasoning_active',
        itemType: 'reasoning',
        runId: 'run_1',
        threadId: 'thread_1',
        body: '正在核验杭州逐小时降水。',
        status: 'running',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 30)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('◐ 正在推理')
      expect(frame).toContain('正在核验杭州逐小时降水')
      assertFrameFits(instance.lastFrame(), 100, 30)
    })
  })

  it('renders assistant Markdown through the terminal renderer at supported widths', async () => {
    const value = snapshot(run('completed'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'answer_markdown',
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: [
          '# 杭州降水结论',
          '',
          '- **今天**：有阵雨',
          '- **明天**：降水减弱',
          '',
          '| 时段 | 风险 |',
          '| --- | --- |',
          '| 午后 | 中等 |',
          '',
          '```text',
          '数据已核验',
          '```',
        ].join('\n'),
        status: 'completed',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 40)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('杭州降水结论')
      expect(frame).toContain('今天：有阵雨')
      expect(frame).toContain('时段')
      expect(frame).toContain('数据已核验')
      expect(frame).not.toContain('**今天**')
      expect(frame).not.toContain('```text')
      assertFrameFits(instance.lastFrame(), 100, 40)
    })
  })

  it('shows the registered tool label, identifier, input and output explicitly', async () => {
    const value = snapshot(run('completed'))
    value.bootstrap = bootstrapWithWeatherTool()
    value.items = [
      conversationItemSchema.parse({
        itemId: 'tool_output',
        itemType: 'function_call_output',
        runId: 'run_1',
        threadId: 'thread_1',
        callId: 'call_weather',
        output: '{"summary":"杭州午后有阵雨。"}',
        status: 'completed',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
      conversationItemSchema.parse({
        itemId: 'tool_call',
        itemType: 'function_call',
        runId: 'run_1',
        threadId: 'thread_1',
        callId: 'call_weather',
        name: 'query_public_weather',
        arguments: '{"location":"杭州"}',
        status: 'completed',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 34)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('已调用工具 · 查询公开天气 [query_public_weather]')
      expect(frame).toContain('输入')
      expect(frame).toContain('{"location":"杭州"}')
      expect(frame).toContain('输出')
      expect(frame).toContain('杭州午后有阵雨。')
    })
  })

  it('defaults approval decisions to rejection and requires double confirmation to approve', async () => {
    const decision = approvalDecision()
    const value = snapshot(run('waiting_approval', [decision]))
    const rejecting = new TestSession(value)
    const rejectView = renderConsole(rejecting)
    resize(rejectView.stdout, 100, 30)
    await vi.waitFor(() => expect(rejectView.lastFrame()).toContain('› 拒绝'))

    rejectView.stdin.write('\r')
    await vi.waitFor(() => expect(rejecting.respondDecision).toHaveBeenCalledWith({
      decisionId: 'approval_1',
      optionId: 'reject',
    }))
    cleanup()

    const approving = new TestSession(snapshot(run('waiting_approval', [decision])))
    const approveView = renderConsole(approving)
    resize(approveView.stdout, 100, 30)
    await vi.waitFor(() => expect(approveView.lastFrame()).toContain('› 拒绝'))
    approveView.stdin.write('\u001b[A')
    approveView.stdin.write('\r')
    await vi.waitFor(() => expect(approveView.lastFrame()).toContain('再次确认'))
    expect(approving.respondDecision).not.toHaveBeenCalled()
    approveView.stdin.write('\r')
    await vi.waitFor(() => expect(approving.respondDecision).toHaveBeenCalledWith({
      decisionId: 'approval_1',
      optionId: 'approve',
    }))
  })

  it('accepts mouse clicks for footer controls without enabling motion capture', async () => {
    const mouse = new TestMouseSource()
    const session = new TestSession(snapshot())
    const instance = renderConsole(session, mouse)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('鼠标可用'))
    await new Promise(resolve => setTimeout(resolve, 30))

    mouse.click(3, 28)

    await vi.waitFor(() => expect(session.setExecutionMode).toHaveBeenCalledWith('plan'))
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('计划   Enter 发送'))
  })
})

class TestSession implements LocalAgentConsoleSession {
  private readonly events = new EventEmitter()
  private current: LocalAgentSessionSnapshot

  readonly close = vi.fn()
  readonly submit = vi.fn(async (_text: string): Promise<AnalysisRun> => this.requireRun())
  readonly respondDecision = vi.fn(async (_input: {
    decisionId: string
    optionId?: string | null
    text?: string | null
  }): Promise<AnalysisRun> => this.requireRun())
  readonly cancel = vi.fn(async (): Promise<AnalysisRun> => this.requireRun())
  readonly resume = vi.fn(async (): Promise<AnalysisRun> => this.requireRun())
  readonly setExecutionMode = vi.fn((mode: AgentExecutionMode) => {
    this.current = { ...this.current, executionMode: mode }
    this.events.emit('state', this.snapshot())
  })
  readonly setReasoning = vi.fn((enabled: boolean) => {
    this.current = { ...this.current, reasoning: enabled }
    this.events.emit('state', this.snapshot())
  })
  readonly newConversation = vi.fn(() => {
    this.current = { ...this.current, threadId: null, run: null, items: [], events: [] }
    this.events.emit('state', this.snapshot())
  })

  constructor(current: LocalAgentSessionSnapshot) {
    this.current = current
  }

  snapshot(): LocalAgentSessionSnapshot {
    return {
      ...this.current,
      items: [...this.current.items],
      events: [...this.current.events],
    }
  }

  subscribe(listener: (value: LocalAgentSessionSnapshot) => void): () => void {
    this.events.on('state', listener)
    return () => this.events.off('state', listener)
  }

  private requireRun(): AnalysisRun {
    if (!this.current.run) throw new Error('测试运行不存在。')
    return this.current.run
  }
}

class TestMouseSource implements TerminalMouseSource {
  readonly enabled = true
  private readonly events = new EventEmitter()

  subscribe(listener: (event: TerminalMouseEvent) => void): () => void {
    this.events.on('mouse', listener)
    return () => this.events.off('mouse', listener)
  }

  click(column: number, row: number): void {
    this.events.emit('mouse', mouseEvent('press', column, row))
    this.events.emit('mouse', mouseEvent('release', column, row))
  }
}

function renderConsole(session: LocalAgentConsoleSession, mouse?: TerminalMouseSource) {
  return render(
    <ThemeProvider theme={geoForgeConsoleTheme}>
      <LocalAgentConsoleApp session={session} identity={identity} {...(mouse ? { mouse } : {})} />
    </ThemeProvider>,
  )
}

function snapshot(currentRun: AnalysisRun | null = null): LocalAgentSessionSnapshot {
  return {
    connection: 'online',
    connectionMessage: '已连接',
    bootstrap: null,
    provider: {
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
    },
    model: 'deepseek-v4-flash',
    executionMode: 'auto',
    reasoning: true,
    threadId: currentRun?.threadId ?? null,
    run: currentRun,
    items: [],
    events: [],
    error: null,
  }
}

function bootstrapWithWeatherTool() {
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
    },
    threads: [],
    providers: [],
    tools: [{
      name: 'query_public_weather',
      label: '查询公开天气',
      description: '查询公开天气资料。',
      group: 'weather',
      toolKind: 'registry',
      providerId: 'public-weather',
      language: 'typescript',
      isReadOnly: true,
      isDestructive: false,
      parallelSafe: true,
      available: true,
      tags: ['weather'],
      parameters: [],
      error: null,
      meta: {},
    }],
  })
}

function run(status: AnalysisRun['status'], decisions: DecisionRequest[] = []): AnalysisRun {
  return analysisRunSchema.parse({
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    userQuery: '杭州明天会下雨吗？',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '杭州明天会下雨吗？',
      decisions,
    },
  })
}

function approvalDecision(): DecisionRequest {
  return {
    decisionId: 'approval_1',
    kind: 'approval',
    title: '执行受保护工具',
    question: '是否允许写入运行结果？',
    description: '',
    options: [{
      optionId: 'approve',
      label: '批准',
      description: '',
      kind: 'approval',
      reason: null,
      payload: { approved: true },
    }, {
      optionId: 'reject',
      label: '拒绝',
      description: '',
      kind: 'approval',
      reason: null,
      payload: { approved: false },
    }],
    allowFreeText: false,
    status: 'pending',
    payload: {},
    createdAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
  }
}

function resize(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  stdout.emit('resize')
}

function assertFrameFits(frame: string, columns: number, rows: number): void {
  const lines = frame.split('\n')
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const line of lines) {
    expect(stringWidth(stripVTControlCharacters(line)), line).toBeLessThanOrEqual(columns)
  }
}

function mouseEvent(kind: TerminalMouseEvent['kind'], column: number, row: number): TerminalMouseEvent {
  return { kind, column, row, button: 'left', deltaY: 0, shift: false, meta: false, ctrl: false }
}

const identity: LocalAgentConsoleIdentity = {
  version: '0.1.0',
  projectRoot: 'C:\\Projects\\Newmap',
  osUser: 'James',
  hostname: '杭州开发机',
  keyVersion: 'v1',
}
