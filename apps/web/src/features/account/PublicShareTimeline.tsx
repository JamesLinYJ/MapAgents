// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开分享时间线
//
//   文件:       PublicShareTimeline.tsx
//
//   日期:       2026年07月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Markdown } from '../../shared/components/Markdown'
import type { ConversationEntry } from '../conversation/items'

interface PublicShareTimelineProps {
  entries: ConversationEntry[]
}

export function PublicShareTimeline({ entries }: PublicShareTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="share-timeline" aria-label="公开对话内容">
      {entries.map(entry => {
        if (entry.kind === 'message' && entry.role === 'user') {
          return <article key={entry.id} className="share-message share-message--user">{entry.body}</article>
        }
        if (entry.kind === 'message') {
          return (
            <article key={entry.id} className="share-message share-message--assistant">
              <Markdown>{entry.body}</Markdown>
            </article>
          )
        }
        if (entry.kind === 'command_batch') {
          const isExpanded = expanded.has(entry.id)
          return (
            <article key={entry.id} className="share-tool">
              <button type="button" onClick={() => toggle(entry.id)} aria-expanded={isExpanded}>
                <span>{entry.title}</span>
                <small>{entry.status}</small>
                <ChevronDown size={15} className={isExpanded ? 'is-open' : undefined} />
              </button>
              {isExpanded ? (
                <div className="share-tool__body">
                  {entry.commands?.map(command => (
                    <section key={command.id}>
                      <strong>{command.title}</strong>
                      <p>{command.body}</p>
                      {command.commandText ? <pre>{command.commandText}</pre> : null}
                    </section>
                  ))}
                </div>
              ) : null}
            </article>
          )
        }
        if (entry.kind === 'error') {
          return <article key={entry.id} className="share-message share-message--error">{entry.body}</article>
        }
        return null
      })}
    </div>
  )
}
