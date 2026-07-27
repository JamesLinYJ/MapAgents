// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 中文本机 Agent 终端
//
//   文件:       localAgentConsole.tsx
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import { ThemeProvider } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink'

import { LocalConsoleMouseProvider, MouseRegion } from '../../localConsoleMouse.js'
import { consolePalette, geoForgeConsoleTheme } from '../../localConsoleTheme.js'
import {
  type LocalAgentSession,
  type LocalAgentSessionSnapshot,
} from '../application/localAgentSession.js'
import {
  buildConversationLines,
  runPresentation,
  type AgentLineTone,
} from './localAgentView.js'
import {
  createTerminalMouseController,
  type TerminalMouseSource,
} from '../../terminalMouse.js'

const MIN_COLUMNS = 80
const MIN_ROWS = 24
const MAX_INPUT_LENGTH = 16_000

export interface LocalAgentConsoleIdentity {
  version: string
  projectRoot: string
  osUser: string
  hostname: string
  keyVersion: string
}

export type LocalAgentConsoleSession = Pick<
  LocalAgentSession,
  | 'snapshot'
  | 'subscribe'
  | 'close'
  | 'submit'
  | 'respondDecision'
  | 'cancel'
  | 'resume'
  | 'setExecutionMode'
  | 'setReasoning'
  | 'newConversation'
>

export async function runLocalAgentConsole(
  session: LocalAgentConsoleSession,
  identity: LocalAgentConsoleIdentity,
): Promise<void> {
  const mouse = createTerminalMouseController(process.stdin, process.stdout, { trackMotion: false })
  const instance = render(
    <ThemeProvider theme={geoForgeConsoleTheme}>
      <LocalAgentConsoleApp session={session} identity={identity} mouse={mouse} />
    </ThemeProvider>,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      stdin: mouse.stdin,
    },
  )
  mouse.activate()
  try {
    await instance.waitUntilExit()
  } finally {
    mouse.close()
  }
}

export function LocalAgentConsoleApp({
  session,
  identity,
  mouse,
}: {
  session: LocalAgentConsoleSession
  identity: LocalAgentConsoleIdentity
  mouse?: TerminalMouseSource
}) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [snapshot, setSnapshot] = useState(() => session.snapshot())
  const [editor, setEditor] = useState<InputEdit>({ value: '', cursorIndex: 0 })
  const input = editor.value
  const cursorIndex = editor.cursorIndex
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [feedback, setFeedback] = useState('就绪。输入自然语言问题，Enter 发送。')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [decisionIndex, setDecisionIndex] = useState(0)
  const decisionIndexRef = useRef(0)
  const [approvalArmed, setApprovalArmed] = useState(false)
  const decisionIdRef = useRef<string | null>(null)
  const lastInterruptRef = useRef(0)

  useEffect(() => session.subscribe(setSnapshot), [session])

  const decision = useMemo(() => pendingDecision(snapshot), [snapshot])
  useEffect(() => {
    if (decision?.decisionId === decisionIdRef.current) return
    decisionIdRef.current = decision?.decisionId ?? null
    setApprovalArmed(false)
    const rejectIndex = decision?.kind === 'approval'
      ? decision.options.findIndex(option => option.payload.approved === false)
      : 0
    const nextIndex = rejectIndex >= 0 ? rejectIndex : 0
    decisionIndexRef.current = nextIndex
    setDecisionIndex(nextIndex)
  }, [decision])

  const disconnect = useCallback(() => {
    session.close()
    exit()
  }, [exit, session])

  const beginNewConversation = useCallback(() => {
    try {
      session.newConversation()
      setFeedback('已开始新的本地 Agent 对话。')
    } catch (error) {
      setFeedback(formatUiError(error))
    }
  }, [session])

  const runAction = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setFeedback(formatUiError(error))
    } finally {
      setBusy(false)
    }
  }, [busy])

  const submitDecision = useCallback((selected: DecisionRequest['options'][number] | null, text?: string) => {
    if (!decision) return
    if (decision.kind === 'approval' && selected?.payload.approved === true && !approvalArmed) {
      setApprovalArmed(true)
      setFeedback('批准可能执行写入或受保护工具；再次按 Enter 或再次单击“批准”确认。')
      return
    }
    void runAction(async () => {
      await session.respondDecision({
        decisionId: decision.decisionId,
        ...(selected?.optionId ? { optionId: selected.optionId } : {}),
        ...(text?.trim() ? { text: text.trim() } : {}),
      })
      setEditor({ value: '', cursorIndex: 0 })
      setApprovalArmed(false)
      setFeedback(decision.kind === 'approval' ? '审批决定已提交，正在恢复原运行。' : '补充信息已提交。')
      setScrollOffset(0)
    })
  }, [approvalArmed, decision, runAction, session])

  const executeCommand = useCallback((value: string): boolean => {
    const [rawCommand, ...parts] = value.trim().split(/\s+/u)
    const command = rawCommand?.toLowerCase()
    if (!command?.startsWith('/')) return false
    const argument = parts.join(' ')
    if (command === '/help' || command === '/?') setHelp(true)
    else if (command === '/exit' || command === '/quit') disconnect()
    else if (command === '/new') beginNewConversation()
    else if (command === '/plan' || (command === '/mode' && argument === 'plan')) {
      session.setExecutionMode('plan')
      setFeedback('下一次运行将使用计划模式。')
    } else if (command === '/auto' || (command === '/mode' && argument === 'auto')) {
      session.setExecutionMode('auto')
      setFeedback('下一次运行将使用自动模式。')
    } else if (command === '/reasoning') {
      const enabled = argument !== 'off'
      session.setReasoning(enabled)
      setFeedback(`思考过程已${enabled ? '开启' : '关闭'}。`)
    } else if (command === '/resume') {
      void runAction(async () => {
        await session.resume()
        setFeedback('运行恢复请求已提交。')
      })
    } else if (command === '/cancel') {
      void runAction(async () => {
        await session.cancel()
        setFeedback('运行已取消。')
      })
    } else if (command === '/model') {
      setFeedback(`当前模型：${snapshot.provider?.displayName ?? '未连接'} / ${snapshot.model ?? '未配置'}；模型由服务端能力清单约束。`)
    } else if (command === '/agents') {
      const agents = snapshot.run?.state.subAgents ?? []
      setFeedback(agents.length
        ? `子智能体：${agents.map(agent => `${agent.name}(${agent.status})`).join('、')}`
        : '当前没有子智能体。')
    } else if (command === '/tools') {
      setFeedback(`当前工作区注册了 ${snapshot.bootstrap?.tools.length ?? 0} 个工具；详细调用会显示在对话时间线。`)
    } else if (command === '/status') {
      const status = runPresentation(snapshot.run?.status)
      setFeedback(`${status.symbol} ${status.label} · ${snapshot.connectionMessage}`)
    } else if (command === '/history') {
      const threads = snapshot.bootstrap?.threads ?? []
      setFeedback(threads.length
        ? `最近对话：${threads.slice(0, 5).map(thread => thread.title).join(' · ')}`
        : '尚无历史对话。')
    } else {
      setFeedback(`未知命令 ${command}；输入 /help 查看可用命令。`)
    }
    return true
  }, [beginNewConversation, disconnect, runAction, session, snapshot])

  const submitInput = useCallback(() => {
    const value = input.trim()
    if (decision?.kind === 'clarification' && value && !value.startsWith('/')) {
      submitDecision(null, value)
      return
    }
    if (value && executeCommand(value)) {
      setEditor({ value: '', cursorIndex: 0 })
      return
    }
    if (decision) {
      const selected = decision.options[decisionIndexRef.current] ?? null
      if (!value && selected) submitDecision(selected)
      else setFeedback(decision.kind === 'approval'
        ? '审批必须使用 ↑↓ 选择“批准”或“拒绝”。'
        : '请选择一个选项，或直接输入补充信息。')
      return
    }
    if (!value) return
    setHistory(current => [...current.filter(item => item !== value), value].slice(-100))
    setHistoryIndex(null)
    setEditor({ value: '', cursorIndex: 0 })
    setScrollOffset(0)
    void runAction(async () => {
      const previousRun = snapshot.run
      await session.submit(value)
      setFeedback(previousRun && ['queued', 'running'].includes(previousRun.status)
        ? '引导消息已排队，不会重放当前运行。'
        : '问题已提交。')
    })
  }, [decision, decisionIndex, executeCommand, input, runAction, session, snapshot.run, submitDecision])

  usePaste(text => {
    if (help || busy) return
    const insertion = text.replace(/\r\n?/gu, '\n')
    setEditor(current => insertText(current.value, current.cursorIndex, insertion, MAX_INPUT_LENGTH))
  }, { isActive: !help && !busy })

  useInput((value, key) => {
    if (help) {
      if (key.escape || key.return || value === '?' || value === '\u001bOP') setHelp(false)
      return
    }
    if (key.ctrl && value === 'c') {
      if (snapshot.run && ['queued', 'running'].includes(snapshot.run.status)) {
        void runAction(async () => {
          await session.cancel()
          setFeedback('运行已取消；服务与监督器保持运行。')
        })
        return
      }
      if (input) {
        setEditor({ value: '', cursorIndex: 0 })
        setFeedback('输入已清空。')
        return
      }
      const now = Date.now()
      if (now - lastInterruptRef.current < 2_000) disconnect()
      else {
        lastInterruptRef.current = now
        setFeedback('再次按 Ctrl+C 分离 Agent；后台服务不会停止。')
      }
      return
    }
    if (key.ctrl && value === 'd' && !input) {
      disconnect()
      return
    }
    if (value === '\u001bOP' || (!input && value === '?')) {
      setHelp(true)
      return
    }
    if (key.escape) {
      setApprovalArmed(false)
      setFeedback('已取消当前界面选择；没有执行任何操作。')
      return
    }
    if (decision && (key.upArrow || key.downArrow)) {
      const length = Math.max(1, decision.options.length)
      const nextIndex = (
        decisionIndexRef.current
        + (key.downArrow ? 1 : -1)
        + length
      ) % length
      decisionIndexRef.current = nextIndex
      setDecisionIndex(nextIndex)
      setApprovalArmed(false)
      return
    }
    if (!decision && !input && (key.upArrow || key.downArrow) && history.length) {
      const next = historyIndex === null
        ? (key.upArrow ? history.length - 1 : 0)
        : Math.max(0, Math.min(history.length - 1, historyIndex + (key.downArrow ? 1 : -1)))
      setHistoryIndex(next)
      const recalled = history[next] ?? ''
      setEditor({ value: recalled, cursorIndex: codePoints(recalled).length })
      return
    }
    if (key.pageUp || key.pageDown) {
      setScrollOffset(offset => Math.max(0, offset + (key.pageUp ? 8 : -8)))
      return
    }
    if (key.ctrl && value === 'j') {
      setEditor(current => insertText(current.value, current.cursorIndex, '\n', MAX_INPUT_LENGTH))
      return
    }
    if (key.return) {
      submitInput()
      return
    }
    if (key.backspace) {
      setEditor(current => removeCodePointBefore(current.value, current.cursorIndex))
      setHistoryIndex(null)
      return
    }
    if (key.delete) {
      setEditor(current => ({
        value: removeCodePointAt(current.value, current.cursorIndex),
        cursorIndex: current.cursorIndex,
      }))
      setHistoryIndex(null)
      return
    }
    if (key.ctrl && value === 'u') {
      setEditor({ value: '', cursorIndex: 0 })
      return
    }
    if (key.leftArrow) {
      setEditor(current => ({ ...current, cursorIndex: Math.max(0, current.cursorIndex - 1) }))
      return
    }
    if (key.rightArrow) {
      setEditor(current => ({
        ...current,
        cursorIndex: Math.min(codePoints(current.value).length, current.cursorIndex + 1),
      }))
      return
    }
    if (key.home) {
      setEditor(current => ({
        ...current,
        cursorIndex: lineStartIndex(current.value, current.cursorIndex),
      }))
      return
    }
    if (key.end) {
      setEditor(current => ({
        ...current,
        cursorIndex: lineEndIndex(current.value, current.cursorIndex),
      }))
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    if (value && !/^\u001b/u.test(value)) {
      setEditor(current => insertText(current.value, current.cursorIndex, value, MAX_INPUT_LENGTH))
      setHistoryIndex(null)
    }
  }, { isActive: !busy && columns >= MIN_COLUMNS && rows >= MIN_ROWS })

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return <AgentSizeWarning columns={columns} rows={rows} onExit={disconnect} />
  }

  const wide = columns >= 140 && rows >= 32
  const compact = columns < 100
  const decisionRows = decision ? Math.min(7, 3 + decision.options.length) : 0
  const contentRows = Math.max(4, rows - (compact ? 8 : 10) - decisionRows)
  const conversationWidth = wide ? columns - 46 : columns - 4
  const allLines = buildConversationLines(snapshot, conversationWidth - 2)
  const maximumOffset = Math.max(0, allLines.length - contentRows)
  const safeOffset = Math.min(scrollOffset, maximumOffset)
  const end = Math.max(0, allLines.length - safeOffset)
  const visibleLines = allLines.slice(Math.max(0, end - contentRows), end)

  return (
    <LocalConsoleMouseProvider source={mouse}>
      <Box width={columns} height={rows} flexDirection="column" backgroundColor={consolePalette.canvas}>
        <AgentHeader snapshot={snapshot} identity={identity} compact={compact} />
        {help
          ? <HelpView onClose={() => setHelp(false)} />
          : <Box flexGrow={1} minHeight={0}>
              <MouseRegion
                flexDirection="column"
                flexGrow={1}
                minWidth={0}
                borderStyle="round"
                borderColor={consolePalette.border}
                paddingX={1}
                onWheel={direction => setScrollOffset(offset =>
                  Math.max(0, Math.min(maximumOffset, offset + (direction < 0 ? 3 : -3))))}
              >
                <Box justifyContent="space-between">
                  <Text bold color={consolePalette.focus}>对话</Text>
                  <Text color={consolePalette.muted}>
                    {safeOffset ? `已上移 ${safeOffset} 行` : '跟随最新'} · 滚轮/PgUp/PgDn
                  </Text>
                </Box>
                {visibleLines.map(line => (
                  <Text
                    key={line.key}
                    {...(line.bold ? { bold: true } : {})}
                    color={lineColor(line.tone)}
                    {...(line.user ? { backgroundColor: consolePalette.panelRaised } : {})}
                    wrap="truncate-end"
                  >
                    {line.text}
                  </Text>
                ))}
              </MouseRegion>
              {wide && <AgentInspector snapshot={snapshot} />}
            </Box>}
        {decision && !help && <DecisionPanel
          decision={decision}
          selectedIndex={decisionIndex}
          armed={approvalArmed}
          onSelect={index => {
            decisionIndexRef.current = index
            setDecisionIndex(index)
            setApprovalArmed(false)
          }}
          onSubmit={option => submitDecision(option)}
        />}
        <AgentComposer
          value={input}
          cursorIndex={cursorIndex}
          busy={busy}
          decision={decision}
          onFocusLatest={() => setScrollOffset(0)}
        />
        <AgentFooter
          snapshot={snapshot}
          feedback={feedback}
          mouseEnabled={Boolean(mouse?.enabled)}
          onMode={() => session.setExecutionMode(snapshot.executionMode === 'auto' ? 'plan' : 'auto')}
          onNew={beginNewConversation}
          onHelp={() => setHelp(true)}
        />
      </Box>
    </LocalConsoleMouseProvider>
  )
}

function AgentHeader({
  snapshot,
  identity,
  compact,
}: {
  snapshot: LocalAgentSessionSnapshot
  identity: LocalAgentConsoleIdentity
  compact: boolean
}) {
  const run = runPresentation(snapshot.run?.status)
  const online = snapshot.connection === 'online'
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={consolePalette.border} paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.focus}>◈ GeoForge Agent <Text color={consolePalette.muted}>v{identity.version}</Text></Text>
        <Text color={online ? consolePalette.healthy : consolePalette.warning}>
          {online ? '● 本机根授权' : '◐ 正在重连'} · {run.symbol} {run.label}
        </Text>
      </Box>
      <Text wrap="truncate-end" color={consolePalette.muted}>
        {snapshot.provider?.displayName ?? '等待提供商'} / {snapshot.model ?? '等待模型'} · {snapshot.executionMode === 'plan' ? '计划模式' : '自动模式'}
        {' · '}{snapshot.reasoning ? '思考开启' : '思考关闭'} · {compact ? identity.projectRoot : `${identity.osUser}@${identity.hostname} · ${identity.projectRoot}`}
      </Text>
    </Box>
  )
}

function AgentInspector({ snapshot }: { snapshot: LocalAgentSessionSnapshot }) {
  const run = snapshot.run
  const workflow = run?.state.agentWorkflow
  const tools = snapshot.items.filter(item => item.itemType === 'function_call')
  const completedTools = snapshot.items.filter(item => item.itemType === 'function_call_output' && !item.isError)
  return (
    <Box width={44} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={consolePalette.border} paddingX={1}>
      <Text bold color={consolePalette.focus}>运行检查器</Text>
      <Text color={runPresentation(run?.status).tone === 'danger' ? consolePalette.danger : consolePalette.text}>
        {runPresentation(run?.status).symbol} {runPresentation(run?.status).label}
      </Text>
      <Text color={consolePalette.muted}>运行 {shortId(run?.id)} · 线程 {shortId(snapshot.threadId)}</Text>
      <Text>工具 {completedTools.length}/{tools.length} · 子智能体 {run?.state.subAgents.length ?? 0}</Text>
      <Text>产物 {run?.state.artifacts.length ?? 0} · 待办 {run?.state.todos.filter(todo => todo.status !== 'completed').length ?? 0}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={consolePalette.focus}>{workflow ? `计划 ${workflow.steps.filter(step => step.status === 'completed').length}/${workflow.steps.length}` : '计划'}</Text>
        {(workflow?.steps ?? []).slice(0, 10).map(step => (
          <Text key={step.stepId} color={step.status === 'failed'
            ? consolePalette.danger
            : step.status === 'completed' ? consolePalette.healthy : step.status === 'running' ? consolePalette.warning : consolePalette.muted}>
            {step.status === 'completed' ? '✓' : step.status === 'running' ? '▶' : step.status === 'failed' ? '✕' : '○'} {step.title}
          </Text>
        ))}
        {!workflow && <Text color={consolePalette.muted}>本次运行尚未生成工作流。</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={consolePalette.focus}>智能体</Text>
        {(run?.state.subAgents ?? []).slice(0, 6).map(agent => (
          <Text key={agent.agentId} color={agent.status === 'failed' ? consolePalette.danger : consolePalette.muted}>
            {agent.status === 'running' ? '↗' : agent.status === 'completed' ? '✓' : '○'} {agent.name}
          </Text>
        ))}
        {!run?.state.subAgents.length && <Text color={consolePalette.muted}>当前仅主智能体运行。</Text>}
      </Box>
    </Box>
  )
}

function DecisionPanel({
  decision,
  selectedIndex,
  armed,
  onSelect,
  onSubmit,
}: {
  decision: DecisionRequest
  selectedIndex: number
  armed: boolean
  onSelect: (index: number) => void
  onSubmit: (option: DecisionRequest['options'][number]) => void
}) {
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={decision.kind === 'approval' ? consolePalette.warning : consolePalette.focus} paddingX={1} flexDirection="column">
      <Text bold color={decision.kind === 'approval' ? consolePalette.warning : consolePalette.focus}>
        {decision.kind === 'approval' ? '! 等待批准' : '? 需要澄清'} · {decision.title}
      </Text>
      <Text wrap="truncate-end">{decision.question}</Text>
      <Box gap={1}>
        {decision.options.map((option, index) => {
          const selected = index === selectedIndex
          const dangerous = option.payload.approved === true
          return (
            <MouseRegion
              key={option.optionId ?? `${decision.decisionId}:${index}`}
              onClick={() => {
                if (selected) onSubmit(option)
                else onSelect(index)
              }}
              priority={40}
            >
              {state => <Text
                bold={selected || state.hovered}
                color={selected ? consolePalette.canvas : dangerous ? consolePalette.warning : consolePalette.text}
                {...(selected
                  ? { backgroundColor: dangerous && armed ? consolePalette.danger : consolePalette.focus }
                  : state.hovered ? { backgroundColor: consolePalette.selected } : {})}
              > {selected ? '›' : ' '} {option.label}{dangerous && armed && selected ? ' · 再次确认' : ''} </Text>}
            </MouseRegion>
          )
        })}
      </Box>
    </Box>
  )
}

function AgentComposer({
  value,
  cursorIndex,
  busy,
  decision,
  onFocusLatest,
}: {
  value: string
  cursorIndex: number
  busy: boolean
  decision: DecisionRequest | null
  onFocusLatest: () => void
}) {
  const visible = visibleInputWindow(value, cursorIndex)
  const placeholder = decision?.kind === 'clarification'
    ? '输入补充说明，或用 ↑↓ 选择上方选项…'
    : decision?.kind === 'approval'
      ? '审批期间请选择上方选项；可输入 /help…'
      : '输入消息…'
  return (
    <MouseRegion
      flexShrink={0}
      height={4}
      borderStyle="round"
      borderColor={busy ? consolePalette.warning : consolePalette.focus}
      paddingX={1}
      onClick={onFocusLatest}
      priority={20}
    >
      <Box flexDirection="column" width="100%">
        <Text color={consolePalette.muted}>{busy ? '◐ 正在提交…' : '›'} {value ? '' : placeholder}</Text>
        <Text wrap="wrap" color={consolePalette.text}>
          {visible.before}<Text inverse>{busy ? ' ' : visible.cursor}</Text>{visible.after}
        </Text>
      </Box>
    </MouseRegion>
  )
}

function AgentFooter({
  snapshot,
  feedback,
  mouseEnabled,
  onMode,
  onNew,
  onHelp,
}: {
  snapshot: LocalAgentSessionSnapshot
  feedback: string
  mouseEnabled: boolean
  onMode: () => void
  onNew: () => void
  onHelp: () => void
}) {
  return (
    <Box flexShrink={0} borderStyle="single" borderColor={consolePalette.border} paddingX={1} flexDirection="column">
      <Box>
        <MouseRegion onClick={onMode} priority={30}>
          {state => <Text bold color={state.hovered ? consolePalette.focus : consolePalette.text}>
            [{snapshot.executionMode === 'auto' ? '自动' : '计划'}]
          </Text>}
        </MouseRegion>
        <Text color={consolePalette.muted}> · Enter 发送 · Ctrl+J 换行 · Ctrl+C 取消/分离 · </Text>
        <MouseRegion onClick={onNew} priority={30}><Text color={consolePalette.focus}>[新对话]</Text></MouseRegion>
        <Text> </Text>
        <MouseRegion onClick={onHelp} priority={30}><Text color={consolePalette.focus}>[? 帮助]</Text></MouseRegion>
      </Box>
      <Text wrap="truncate-end" color={snapshot.error ? consolePalette.danger : consolePalette.muted}>
        {feedback} · {snapshot.connectionMessage} · 鼠标{mouseEnabled ? '可用' : '不可用'}
      </Text>
    </Box>
  )
}

function HelpView({ onClose }: { onClose: () => void }) {
  return (
    <Box flexGrow={1} borderStyle="round" borderColor={consolePalette.focus} paddingX={2} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.focus}>GeoForge Agent 快捷键与命令</Text>
        <MouseRegion onClick={onClose} priority={50}><Text color={consolePalette.focus}>[关闭]</Text></MouseRegion>
      </Box>
      <Text>Enter 发送 · Ctrl+J 换行 · ↑↓ 历史/决策 · PgUp/PgDn 或滚轮浏览</Text>
      <Text>Ctrl+C：运行中取消；有输入时清空；空闲连续两次分离 · Ctrl+D 空输入分离</Text>
      <Text color={consolePalette.warning}>审批：默认焦点优先“拒绝”；批准必须再次确认。</Text>
      <Text>/new 新对话 · /history 最近对话 · /status 状态 · /model 模型</Text>
      <Text>/plan 计划模式 · /auto 自动模式 · /reasoning on|off · /resume · /cancel</Text>
      <Text>/tools 工具摘要 · /agents 子智能体摘要 · /exit 分离</Text>
      <Text color={consolePalette.muted}>普通字母（包括 q、?、S、R）在输入区只会作为文本，不会触发运维操作。</Text>
      <Text color={consolePalette.muted}>鼠标只捕获点击与滚轮；终端原生文本选择不启用移动追踪。</Text>
    </Box>
  )
}

function AgentSizeWarning({
  columns,
  rows,
  onExit,
}: {
  columns: number
  rows: number
  onExit: () => void
}) {
  useInput((value, key) => {
    if ((key.ctrl && value === 'c') || (key.ctrl && value === 'd')) onExit()
  })
  return (
    <Box width={Math.max(1, columns)} height={Math.max(1, rows)} justifyContent="center" alignItems="center" flexDirection="column">
      <Text bold color={consolePalette.warning}>终端尺寸不足，Agent 界面已暂停渲染。</Text>
      <Text>当前 {columns}×{rows}，至少需要 {MIN_COLUMNS}×{MIN_ROWS}。</Text>
      <Text color={consolePalette.muted}>请放大窗口；Ctrl+C 或 Ctrl+D 分离，不停止后台服务。</Text>
    </Box>
  )
}

function pendingDecision(snapshot: LocalAgentSessionSnapshot): DecisionRequest | null {
  const decisions = snapshot.run?.state.decisions ?? []
  return decisions.find(item => item.status === 'pending' && item.kind === 'approval')
    ?? decisions.find(item => item.status === 'pending' && item.kind === 'clarification')
    ?? null
}

function lineColor(tone: AgentLineTone): string {
  if (tone === 'focus') return consolePalette.focus
  if (tone === 'healthy') return consolePalette.healthy
  if (tone === 'warning') return consolePalette.warning
  if (tone === 'danger') return consolePalette.danger
  if (tone === 'muted') return consolePalette.muted
  return consolePalette.text
}

interface InputEdit {
  value: string
  cursorIndex: number
}

function insertText(value: string, cursorIndex: number, insertion: string, maximum: number): InputEdit {
  const current = codePoints(value)
  const inserted = codePoints(insertion)
  const available = Math.max(0, maximum - current.length)
  const accepted = inserted.slice(0, available)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  current.splice(safeIndex, 0, ...accepted)
  return { value: current.join(''), cursorIndex: safeIndex + accepted.length }
}

function removeCodePointBefore(value: string, cursorIndex: number): InputEdit {
  const current = codePoints(value)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  if (safeIndex > 0) current.splice(safeIndex - 1, 1)
  return { value: current.join(''), cursorIndex: Math.max(0, safeIndex - 1) }
}

function removeCodePointAt(value: string, cursorIndex: number): string {
  const current = codePoints(value)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  if (safeIndex < current.length) current.splice(safeIndex, 1)
  return current.join('')
}

function lineStartIndex(value: string, cursorIndex: number): number {
  const current = codePoints(value)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  return current.lastIndexOf('\n', safeIndex - 1) + 1
}

function lineEndIndex(value: string, cursorIndex: number): number {
  const current = codePoints(value)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  const next = current.indexOf('\n', safeIndex)
  return next < 0 ? current.length : next
}

function visibleInputWindow(
  value: string,
  cursorIndex: number,
): { before: string; cursor: string; after: string } {
  const current = codePoints(value)
  const safeIndex = Math.max(0, Math.min(current.length, cursorIndex))
  const start = Math.max(0, safeIndex - 500)
  const end = Math.min(current.length, Math.max(safeIndex + 1, start + 1_000))
  return {
    before: `${start > 0 ? '…' : ''}${current.slice(start, safeIndex).join('')}`,
    cursor: current[safeIndex] ?? ' ',
    after: current.slice(safeIndex + (safeIndex < current.length ? 1 : 0), end).join('')
      + (end < current.length ? '…' : ''),
  }
}

function codePoints(value: string): string[] {
  return Array.from(value)
}

function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function formatUiError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : '未知错误。'
  return `操作失败：${message.replace(/[\r\n]+/gu, ' ').slice(0, 500)}；未确认的写操作不会自动重放。`
}
