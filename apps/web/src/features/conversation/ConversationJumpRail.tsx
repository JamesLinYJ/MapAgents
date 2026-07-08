// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话跳转轨道
//
//   文件:       ConversationJumpRail.tsx
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useState } from 'react'
import type { ConversationEntry } from './items'

export interface ConversationJumpItem {
  id: string
  anchorId: string
  label: string
  sequence: number
}

interface ConversationJumpRailProps {
  items: ConversationJumpItem[]
  activeAnchorId: string | null
  onJump: (anchorId: string) => void
}

export function buildConversationJumpItems(conversation: ReadonlyArray<ConversationEntry>): ConversationJumpItem[] {
  return conversation
    .filter((entry) => entry.kind === 'message' && entry.role === 'user' && entry.body.trim())
    .map((entry, index) => ({
      id: entry.id,
      anchorId: conversationJumpAnchorId(entry.id),
      label: compactJumpLabel(entry.body),
      sequence: index + 1,
    }))
}

export function conversationJumpAnchorId(entryId: string) {
  return `cc-jump-${entryId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
}

export function ConversationJumpRail({ items, activeAnchorId, onJump }: ConversationJumpRailProps) {
  const [isOpen, setIsOpen] = useState(false)

  if (items.length < 2) return null

  const activeItem = items.find(item => item.anchorId === activeAnchorId) ?? items.at(-1)

  return (
    <aside
      className={`cc-jump-rail ${isOpen ? 'cc-jump-rail--open' : ''}`}
      aria-label="对话跳转"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        className="cc-jump-rail__toggle"
        type="button"
        aria-label={isOpen ? '关闭对话跳转列表' : '打开对话跳转列表'}
        aria-expanded={isOpen}
        aria-controls="cc-jump-rail-list"
        onClick={() => setIsOpen(open => !open)}
      >
        <span className="sr-only">打开对话跳转列表</span>
        <span className="cc-jump-rail__ticks" aria-hidden="true">
          {items.map(item => (
            <span
              key={item.anchorId}
              className={`cc-jump-rail__tick ${item.anchorId === activeItem?.anchorId ? 'cc-jump-rail__tick--active' : ''}`}
            />
          ))}
        </span>
      </button>

      <div
        id="cc-jump-rail-list"
        className="cc-jump-rail__popover"
        role="listbox"
        aria-label="用户提问索引"
        aria-hidden={!isOpen}
      >
        <div className="cc-jump-rail__head">
          <strong>对话索引</strong>
          <span>{items.length} 条提问</span>
        </div>
        <div className="cc-jump-rail__list">
          {items.map(item => (
            <button
              key={item.anchorId}
              type="button"
              className={`cc-jump-rail__item ${item.anchorId === activeItem?.anchorId ? 'cc-jump-rail__item--active' : ''}`}
              role="option"
              aria-selected={item.anchorId === activeItem?.anchorId}
              tabIndex={isOpen ? 0 : -1}
              title={item.label}
              onClick={() => {
                onJump(item.anchorId)
                setIsOpen(false)
              }}
            >
              <span>{item.sequence}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

function compactJumpLabel(value: string) {
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length <= 32) return text
  return `${text.slice(0, 31)}…`
}
