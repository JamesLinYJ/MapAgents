// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 本机 Agent 对话终端投影
//
//   文件:       localAgentView.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import type { ConversationItem, RunStatus } from '@geo-agent-platform/shared-types'
import stringWidth from 'string-width'

import type { LocalAgentSessionSnapshot } from '../application/localAgentSession.js'

export type AgentLineTone = 'text' | 'muted' | 'focus' | 'healthy' | 'warning' | 'danger'

export interface AgentDisplayLine {
  key: string
  text: string
  tone: AgentLineTone
  bold?: boolean
  user?: boolean
}

export interface AgentRunPresentation {
  symbol: string
  label: string
  tone: AgentLineTone
}

export function buildConversationLines(
  snapshot: LocalAgentSessionSnapshot,
  width: number,
): AgentDisplayLine[] {
  const safeWidth = Math.max(16, width)
  const outputByCall = new Map(snapshot.items
    .filter(item => item.itemType === 'function_call_output' && item.callId)
    .map(item => [item.callId as string, item]))
  const lines: AgentDisplayLine[] = []

  for (const item of [...snapshot.items].sort(compareItems)) {
    if (item.itemType === 'function_call_output' && item.callId) {
      const hasCall = snapshot.items.some(candidate =>
        candidate.itemType === 'function_call' && candidate.callId === item.callId)
      if (hasCall) continue
    }
    if (item.itemType === 'message') {
      const body = itemBody(item)
      if (!body) continue
      const user = item.role === 'user'
      const commentary = item.metadata.messageKind === 'commentary'
      appendEntry(lines, {
        key: item.itemId,
        title: user ? '› 你' : commentary ? '◌ 过程说明' : '◆ GeoForge',
        body,
        width: safeWidth,
        titleTone: user ? 'text' : commentary ? 'muted' : 'focus',
        bodyTone: user ? 'text' : commentary ? 'muted' : 'text',
        user,
      })
      continue
    }
    if (item.itemType === 'reasoning') {
      const body = itemBody(item)
      if (!body) continue
      appendEntry(lines, {
        key: item.itemId,
        title: item.status === 'running' ? '◐ 正在思考' : '◌ 思考过程',
        body,
        width: safeWidth,
        titleTone: item.status === 'running' ? 'warning' : 'muted',
        bodyTone: 'muted',
      })
      continue
    }
    if (item.itemType === 'function_call') {
      const output = item.callId ? outputByCall.get(item.callId) : undefined
      const failed = Boolean(output?.isError || output?.status === 'failed')
      const done = Boolean(output)
      const label = toolLabel(item, output)
      const summary = output ? summarizeToolOutput(output) : summarizeArguments(item.arguments)
      appendEntry(lines, {
        key: `tool:${item.callId ?? item.itemId}`,
        title: `${failed ? '✕' : done ? '✓' : '↳'} ${label}`,
        body: summary,
        width: safeWidth,
        titleTone: failed ? 'danger' : done ? 'healthy' : 'warning',
        bodyTone: 'muted',
        compact: true,
      })
      continue
    }
    if (item.itemType === 'function_call_output') {
      const failed = item.isError || item.status === 'failed'
      appendEntry(lines, {
        key: `tool-output:${item.itemId}`,
        title: `${failed ? '✕' : '✓'} ${toolLabel(undefined, item)}`,
        body: summarizeToolOutput(item),
        width: safeWidth,
        titleTone: failed ? 'danger' : 'healthy',
        bodyTone: 'muted',
        compact: true,
      })
      continue
    }
    if (item.itemType === 'error') {
      appendEntry(lines, {
        key: item.itemId,
        title: '✕ 运行出错',
        body: itemBody(item) || '服务端没有返回具体原因。',
        width: safeWidth,
        titleTone: 'danger',
        bodyTone: 'danger',
      })
      continue
    }
    if (item.itemType === 'result') {
      const resultType = String(item.metadata.resultType ?? '')
      if (!resultType || resultType === 'success' || resultType === 'completed') continue
      const failed = resultType === 'failed'
      appendEntry(lines, {
        key: item.itemId,
        title: failed ? '✕ 运行失败' : '◆ 需要操作',
        body: itemBody(item) || formatResultType(resultType),
        width: safeWidth,
        titleTone: failed ? 'danger' : 'warning',
        bodyTone: failed ? 'danger' : 'text',
      })
    }
  }

  if (!lines.length) {
    lines.push({
      key: 'empty',
      text: '输入自然语言问题开始分析；Agent 会在需要时请求澄清或审批。',
      tone: 'muted',
    })
  }
  return lines
}

export function runPresentation(status: RunStatus | null | undefined): AgentRunPresentation {
  if (!status) return { symbol: '○', label: '等待输入', tone: 'muted' }
  const presentations: Record<RunStatus, AgentRunPresentation> = {
    queued: { symbol: '◌', label: '排队中', tone: 'muted' },
    running: { symbol: '◐', label: '正在运行', tone: 'warning' },
    clarification_needed: { symbol: '?', label: '等待澄清', tone: 'warning' },
    waiting_approval: { symbol: '!', label: '等待批准', tone: 'warning' },
    completed: { symbol: '✓', label: '已完成', tone: 'healthy' },
    failed: { symbol: '✕', label: '失败', tone: 'danger' },
    cancelled: { symbol: '○', label: '已取消', tone: 'muted' },
    interrupted: { symbol: '▲', label: '已中断，可恢复', tone: 'warning' },
    requires_action: { symbol: '◆', label: '需要操作', tone: 'warning' },
  }
  return presentations[status]
}

export function latestAssistantAnswer(items: ConversationItem[]): string {
  return [...items].reverse()
    .find(item => item.itemType === 'message'
      && item.role === 'assistant'
      && item.metadata.messageKind !== 'commentary'
      && Boolean(itemBody(item)))?.body?.trim() ?? ''
}

function appendEntry(
  lines: AgentDisplayLine[],
  input: {
    key: string
    title: string
    body: string
    width: number
    titleTone: AgentLineTone
    bodyTone: AgentLineTone
    user?: boolean
    compact?: boolean
  },
): void {
  if (lines.length && !input.compact) {
    lines.push({ key: `${input.key}:space`, text: '', tone: 'muted' })
  }
  lines.push({
    key: `${input.key}:title`,
    text: input.title,
    tone: input.titleTone,
    bold: true,
    ...(input.user ? { user: true } : {}),
  })
  const indentation = input.compact ? '  ' : '  '
  const wrapped = wrapTerminalText(input.body, Math.max(8, input.width - stringWidth(indentation)))
  for (const [index, line] of wrapped.entries()) {
    lines.push({
      key: `${input.key}:body:${index}`,
      text: `${indentation}${line}`,
      tone: input.bodyTone,
      ...(input.user ? { user: true } : {}),
    })
  }
}

function wrapTerminalText(value: string, width: number): string[] {
  const safe = stripVTControlCharacters(value).replace(/\r\n?/gu, '\n')
  const output: string[] = []
  for (const logicalLine of safe.split('\n')) {
    if (!logicalLine) {
      output.push('')
      continue
    }
    let line = ''
    let lineWidth = 0
    for (const character of Array.from(logicalLine)) {
      const characterWidth = Math.max(0, stringWidth(character))
      if (line && lineWidth + characterWidth > width) {
        output.push(line)
        line = ''
        lineWidth = 0
      }
      line += character
      lineWidth += characterWidth
    }
    output.push(line)
  }
  return output
}

function compareItems(left: ConversationItem, right: ConversationItem): number {
  return left.timestamp.localeCompare(right.timestamp) || left.itemId.localeCompare(right.itemId)
}

function itemBody(item: ConversationItem): string {
  return (item.body ?? item.output ?? '').trim()
}

function toolLabel(call: ConversationItem | undefined, output: ConversationItem | undefined): string {
  for (const item of [call, output]) {
    const label = item?.metadata.toolLabel
    if (typeof label === 'string' && label.trim()) return label.trim()
  }
  return call?.name ?? output?.name ?? '工具调用'
}

function summarizeArguments(value: string | null): string {
  if (!value?.trim()) return '等待工具返回…'
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
}

function summarizeToolOutput(item: ConversationItem): string {
  const raw = itemBody(item)
  if (!raw) return item.isError ? '工具执行失败。' : '工具执行完成。'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') return limit(parsed)
    if (isRecord(parsed)) {
      for (const value of [parsed.answer, parsed.summary, parsed.message, parsed.text, parsed.detail, parsed.error]) {
        if (typeof value === 'string' && value.trim()) return limit(value.trim())
      }
      const payload = isRecord(parsed.payload) ? parsed.payload : null
      if (payload) {
        for (const value of [payload.answer, payload.summary, payload.message, payload.text]) {
          if (typeof value === 'string' && value.trim()) return limit(value.trim())
        }
      }
      const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.length : 0
      if (artifacts) return `执行完成，生成 ${artifacts} 个可核验结果。`
      return item.isError ? '工具执行失败；展开运行详情可查看结构化错误。' : '工具执行完成。'
    }
  } catch {
    return limit(raw)
  }
  return limit(raw)
}

function limit(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 360 ? `${compact.slice(0, 357)}…` : compact
}

function formatResultType(value: string): string {
  if (value === 'waiting_approval') return '运行暂停，等待审批。'
  if (value === 'clarification_needed' || value === 'waiting_clarification') return '运行暂停，等待补充信息。'
  if (value === 'cancelled') return '运行已取消。'
  return '运行暂停，等待下一步操作。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
