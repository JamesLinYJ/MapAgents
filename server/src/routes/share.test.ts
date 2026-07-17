import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadRecord, SessionRecord } from '../schemas/types.js'
import { InvalidHistoryCursorError } from '../store/conversationEncoding.js'
import { shareRoutes, type PublicShareStore } from './share.js'

const session = {
  id: 'session-1',
  shareToken: 'share-1',
  status: 'active',
  createdAt: '2026-07-13T00:00:00.000Z',
  latestThreadId: 'thread-1',
} as SessionRecord

const thread = {
  id: 'thread-1',
  sessionId: session.id,
  title: '公开对话',
  status: 'active',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  latestUserQuery: null,
  latestAssistantSummary: null,
  historyPreview: null,
  runCount: 1,
} as AgentThreadRecord

function createApp(listThreadHistory = vi.fn<PublicShareStore['listThreadHistory']>().mockResolvedValue({
  entries: [],
  nextCursor: 'next-page',
})) {
  const store: PublicShareStore = {
    getSessionByShareToken: token => token === session.shareToken ? session : null,
    listThreadsForSession: sessionId => sessionId === session.id ? [thread] : [],
    listThreadHistory,
  }
  const app = new Hono()
  app.route('/', shareRoutes(store))
  return { app, listThreadHistory }
}

describe('public share route', () => {
  it('returns a single bounded history page and forwards the cursor', async () => {
    const { app, listThreadHistory } = createApp()

    const response = await app.request('/api/share/share-1?threadId=thread-1&cursor=cursor_1&limit=37')
    const payload = await response.json() as { history: { nextCursor: string | null } }

    expect(response.status).toBe(200)
    expect(payload.history.nextCursor).toBe('next-page')
    expect(listThreadHistory).toHaveBeenCalledTimes(1)
    expect(listThreadHistory).toHaveBeenCalledWith('thread-1', 'cursor_1', 37)
  })

  it('rejects unbounded or malformed pagination before reading history', async () => {
    const { app, listThreadHistory } = createApp()

    const response = await app.request('/api/share/share-1?limit=201')

    expect(response.status).toBe(400)
    expect(listThreadHistory).not.toHaveBeenCalled()
  })

  it('maps an invalid opaque cursor to a stable client error', async () => {
    const history = vi.fn<PublicShareStore['listThreadHistory']>().mockRejectedValue(new InvalidHistoryCursorError())
    const { app } = createApp(history)

    const response = await app.request('/api/share/share-1?cursor=invalid')
    const payload = await response.json() as { detail: string }

    expect(response.status).toBe(400)
    expect(payload.detail).toBe('历史记录分页游标无效。')
  })
})
