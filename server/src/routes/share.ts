// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开只读分享路由
//
//   文件:       share.ts
//
//   日期:       2026年07月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { z } from 'zod'
import type { AgentThreadRecord, SessionRecord } from '../schemas/types.js'
import type { ThreadHistoryPage } from '@geo-agent-platform/shared-types'
import { InvalidHistoryCursorError } from '../store/fileConversationIo.js'

const publicShareQuerySchema = z.object({
  threadId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  cursor: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export interface PublicShareStore {
  getSessionByShareToken(shareToken: string): SessionRecord | null
  listThreadsForSession(sessionId: string): AgentThreadRecord[]
  listThreadHistory(threadId: string, cursor?: string | null, limit?: number): Promise<ThreadHistoryPage>
}

export function shareRoutes(store: PublicShareStore) {
  const app = new Hono()

  app.get('/api/share/:shareId', async c => {
    const shareId = c.req.param('shareId')?.trim()
    if (!shareId) return c.json({ detail: '分享链接无效。' }, 400)
    const parsedQuery = publicShareQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) return c.json({ detail: '分享查询参数无效。' }, 400)

    const session = store.getSessionByShareToken(shareId)
    if (!session || session.status !== 'active') return c.json({ detail: '分享不存在或已失效。' }, 404)

    const requestedThreadId = parsedQuery.data.threadId ?? null
    const threads = store.listThreadsForSession(session.id).map(publicThread)
    const selected = requestedThreadId
      ? threads.find(thread => thread.id === requestedThreadId)
      : threads.find(thread => thread.id === session.latestThreadId) ?? threads[0] ?? null
    if (requestedThreadId && !selected) return c.json({ detail: '分享中不存在这条对话。' }, 404)
    let history: ThreadHistoryPage | null = null
    if (selected) {
      try {
        history = await store.listThreadHistory(
          selected.id,
          parsedQuery.data.cursor ?? null,
          parsedQuery.data.limit,
        )
      } catch (error) {
        if (error instanceof InvalidHistoryCursorError) {
          return c.json({ detail: error.message }, 400)
        }
        throw error
      }
    }

    return c.json({
      shareId,
      session: {
        createdAt: session.createdAt,
        status: session.status,
      },
      threads,
      selectedThread: selected,
      history,
    })
  })

  return app
}

function publicThread(thread: AgentThreadRecord) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    latestUserQuery: thread.latestUserQuery,
    latestAssistantSummary: thread.latestAssistantSummary,
    historyPreview: thread.historyPreview,
    runCount: thread.runCount,
  }
}
