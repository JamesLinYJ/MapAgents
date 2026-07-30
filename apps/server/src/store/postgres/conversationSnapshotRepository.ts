// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 会话快照持久化
//
//   文件:       conversationSnapshotRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import { platformRuns, platformSessions, platformThreads } from '../../db/schema.js'
import type {
  ConversationSnapshot,
  ConversationSnapshotRepository,
} from './conversationPersistencePorts.js'
import {
  mapAnalysisRunRow,
  mapDeletedThreadRow,
  mapSessionRow,
  mapThreadRow,
} from './conversationRowMappers.js'

export class PostgresConversationSnapshotRepository implements ConversationSnapshotRepository {
  constructor(private readonly db: Database) {}

  async loadSnapshot(): Promise<ConversationSnapshot> {
    const [sessionRows, threadRows, runRows] = await Promise.all([
      this.db.select().from(platformSessions),
      this.db.select().from(platformThreads),
      this.db.select().from(platformRuns),
    ])
    const activeThreadRows = threadRows.filter(row => row.status !== 'deleted')
    const activeThreadIds = new Set(activeThreadRows.map(row => row.threadId))
    return {
      sessions: sessionRows.map(mapSessionRow),
      threads: activeThreadRows.map(mapThreadRow),
      deletedThreads: threadRows
        .filter(row => row.status === 'deleted')
        .map(mapDeletedThreadRow),
      runs: runRows
        .filter(row => row.threadId === null || activeThreadIds.has(row.threadId))
        .map(mapAnalysisRunRow),
    }
  }
}
