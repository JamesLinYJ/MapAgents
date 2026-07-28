// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 终端 Markdown 适配器
//
//   文件:       terminalMarkdown.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import { render } from 'markdansi'
import wrapAnsi from 'wrap-ansi'

export interface TerminalMarkdownLine {
  text: string
  rendered: string
}

const geoForgeMarkdownTheme = {
  heading: { color: '#39D0D8', bold: true },
  strong: { bold: true },
  emph: { color: '#DD8CFF', italic: true },
  inlineCode: { color: '#FFC857' },
  blockCode: { color: '#EAF4FF' },
  link: { color: '#59A9FF', underline: true },
  quote: { color: '#9A8CFF', italic: true },
  hr: { color: '#427D93' },
  listMarker: { color: '#52DDA0' },
  tableHeader: { color: '#59A9FF', bold: true },
  tableCell: { color: '#EAF4FF' },
} as const

/**
 * Markdown 的 GFM 解析、终端折行、表格、列表和代码框统一交给 markdansi。
 * 适配层只负责清除外来 VT 控制符、关闭 OSC-8 链接并拆成可滚动物理行。
 */
export function renderTerminalMarkdown(markdown: string, width: number): TerminalMarkdownLine[] {
  const safeMarkdown = sanitizeExternalText(markdown).replace(/\r\n?/gu, '\n')
  if (!safeMarkdown.trim()) return []
  const rendered = render(safeMarkdown, {
    wrap: true,
    width: Math.max(8, width),
    color: true,
    hyperlinks: false,
    theme: geoForgeMarkdownTheme,
    quotePrefix: '│ ',
    tableBorder: 'unicode',
    tableTruncate: true,
    codeBox: true,
    codeWrap: true,
  })
  return splitRenderedLines(rendered)
}

export function terminalPlainLine(text: string): TerminalMarkdownLine {
  const safeText = sanitizeExternalText(text)
  return { text: safeText, rendered: safeText }
}

export function renderTerminalPlainText(text: string, width: number): TerminalMarkdownLine[] {
  const safeText = sanitizeExternalText(text).replace(/\r\n?/gu, '\n')
  if (!safeText) return []
  const wrapped = wrapAnsi(safeText, Math.max(1, width), {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  return wrapped.split('\n').map(line => ({ text: line, rendered: line }))
}

function splitRenderedLines(value: string): TerminalMarkdownLine[] {
  const renderedLines = value.replace(/\r\n?/gu, '\n').split('\n')
  const lines = renderedLines.map(rendered => ({
    rendered,
    text: stripVTControlCharacters(rendered),
  }))
  while (lines[0]?.text === '') lines.shift()
  while (lines.at(-1)?.text === '') lines.pop()
  return lines
}

function sanitizeExternalText(value: string): string {
  return stripVTControlCharacters(value).replace(/\u0000/gu, '')
}
