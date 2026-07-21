// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维终端持久化
//
//   文件:       terminalRepository.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  opsTerminalSessionSchema,
  opsTranscriptSummarySchema,
  type OpsTerminalSession,
  type OpsTerminalState,
  type OpsTranscriptSummary,
} from '@geo-agent-platform/shared-types/operations'
import { and, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'

import type { Database } from '../db/connection.js'
import {
  platformTerminalAccessGrants,
  platformTerminalSessions,
  platformTerminalTranscriptChunks,
  platformUsers,
} from '../db/schema.js'
import { makeId } from '../utils/ids.js'
import type { WrappedTerminalDataKey } from './keyring.js'

const ACTIVE_STATES: OpsTerminalState[] = ['starting', 'running', 'detached']

export interface TerminalSessionSecretRecord extends WrappedTerminalDataKey {
  terminalId: string
  ownerUserId: string
  shell: string
  initialCols: number
  initialRows: number
  createdAt: Date
}

export interface TerminalChunkRecord {
  terminalId: string
  sequence: number
  contentHash: string
  sizeBytes: number
  eventCount: number
  firstEventMilliseconds: number
  lastEventMilliseconds: number
  createdAt: Date
}

export class TerminalRepository {
  constructor(private readonly db: Database) {}

  async insertSession(input: {
    terminalId: string
    ownerUserId: string
    label: string
    shell: string
    cols: number
    rows: number
    expiresAt: Date
    retainedUntil: Date
    wrapped: WrappedTerminalDataKey
  }): Promise<void> {
    await this.db.insert(platformTerminalSessions).values({
      terminalId: input.terminalId,
      ownerUserId: input.ownerUserId,
      label: input.label,
      state: 'starting',
      shell: input.shell,
      initialCols: input.cols,
      initialRows: input.rows,
      currentCols: input.cols,
      currentRows: input.rows,
      expiresAt: input.expiresAt,
      retainedUntil: input.retainedUntil,
      keyId: input.wrapped.keyId,
      wrappedDataKey: input.wrapped.wrappedDataKey,
      keyWrapNonce: input.wrapped.keyWrapNonce,
      keyWrapAuthTag: input.wrapped.keyWrapAuthTag,
    })
  }

  async updateSession(input: {
    terminalId: string
    state: OpsTerminalState
    cols: number
    rows: number
    pid: number | null
    exitCode: number | null
    recordedBytes: number
    startedAt: Date | null
    detachedAt: Date | null
    endedAt: Date | null
    failureCode?: string | null
    failureMessage?: string | null
  }): Promise<void> {
    await this.db.update(platformTerminalSessions).set({
      state: input.state,
      currentCols: input.cols,
      currentRows: input.rows,
      pid: input.pid,
      exitCode: input.exitCode,
      recordedBytes: input.recordedBytes,
      startedAt: input.startedAt,
      detachedAt: input.detachedAt,
      endedAt: input.endedAt,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
      lastActivityAt: new Date(),
    }).where(eq(platformTerminalSessions.terminalId, input.terminalId))
  }

  async listSessions(ownerUserId?: string): Promise<OpsTerminalSession[]> {
    const query = this.db.select({
      terminal: platformTerminalSessions,
      ownerDisplayName: platformUsers.displayName,
    }).from(platformTerminalSessions)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformTerminalSessions.ownerUserId))
    const rows = ownerUserId
      ? await query.where(eq(platformTerminalSessions.ownerUserId, ownerUserId))
        .orderBy(desc(platformTerminalSessions.createdAt)).limit(100)
      : await query.orderBy(desc(platformTerminalSessions.createdAt)).limit(100)
    return rows.map(row => mapSession(row.terminal, row.ownerDisplayName))
  }

  async getSession(terminalId: string): Promise<OpsTerminalSession | null> {
    const rows = await this.db.select({
      terminal: platformTerminalSessions,
      ownerDisplayName: platformUsers.displayName,
    }).from(platformTerminalSessions)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformTerminalSessions.ownerUserId))
      .where(eq(platformTerminalSessions.terminalId, terminalId))
      .limit(1)
    const row = rows[0]
    return row ? mapSession(row.terminal, row.ownerDisplayName) : null
  }

  async getSessionSecret(terminalId: string): Promise<TerminalSessionSecretRecord | null> {
    const rows = await this.db.select().from(platformTerminalSessions)
      .where(eq(platformTerminalSessions.terminalId, terminalId)).limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      terminalId: row.terminalId,
      ownerUserId: row.ownerUserId,
      shell: row.shell,
      initialCols: row.initialCols,
      initialRows: row.initialRows,
      createdAt: row.createdAt,
      keyId: row.keyId,
      wrappedDataKey: row.wrappedDataKey,
      keyWrapNonce: row.keyWrapNonce,
      keyWrapAuthTag: row.keyWrapAuthTag,
    }
  }

  async listSessionSecrets(): Promise<TerminalSessionSecretRecord[]> {
    const rows = await this.db.select().from(platformTerminalSessions)
    return rows.map(row => ({
      terminalId: row.terminalId,
      ownerUserId: row.ownerUserId,
      shell: row.shell,
      initialCols: row.initialCols,
      initialRows: row.initialRows,
      createdAt: row.createdAt,
      keyId: row.keyId,
      wrappedDataKey: row.wrappedDataKey,
      keyWrapNonce: row.keyWrapNonce,
      keyWrapAuthTag: row.keyWrapAuthTag,
    }))
  }

  async updateWrappedDataKey(
    terminalId: string,
    previousKeyId: string,
    wrapped: WrappedTerminalDataKey,
  ): Promise<boolean> {
    const rows = await this.db.update(platformTerminalSessions).set({
      keyId: wrapped.keyId,
      wrappedDataKey: wrapped.wrappedDataKey,
      keyWrapNonce: wrapped.keyWrapNonce,
      keyWrapAuthTag: wrapped.keyWrapAuthTag,
    }).where(and(
      eq(platformTerminalSessions.terminalId, terminalId),
      eq(platformTerminalSessions.keyId, previousKeyId),
    )).returning({ terminalId: platformTerminalSessions.terminalId })
    return rows.length === 1
  }

  async countActive(ownerUserId?: string): Promise<number> {
    const conditions = [inArray(platformTerminalSessions.state, ACTIVE_STATES)]
    if (ownerUserId) conditions.push(eq(platformTerminalSessions.ownerUserId, ownerUserId))
    const rows = await this.db.select({ terminalId: platformTerminalSessions.terminalId })
      .from(platformTerminalSessions).where(and(...conditions))
    return rows.length
  }

  async appendChunk(input: Omit<TerminalChunkRecord, 'createdAt'>): Promise<boolean> {
    return this.db.transaction(async tx => {
      const inserted = await tx.insert(platformTerminalTranscriptChunks).values(input)
        .onConflictDoNothing()
        .returning({ terminalId: platformTerminalTranscriptChunks.terminalId })
      if (!inserted.length) return false
      await tx.update(platformTerminalSessions).set({
        recordedBytes: sql`(
          SELECT COALESCE(SUM(${platformTerminalTranscriptChunks.sizeBytes}), 0)::integer
          FROM ${platformTerminalTranscriptChunks}
          WHERE ${platformTerminalTranscriptChunks.terminalId} = ${input.terminalId}
        )`,
        lastChunkSequence: sql`GREATEST(${platformTerminalSessions.lastChunkSequence}, ${input.sequence})`,
        lastActivityAt: new Date(),
      }).where(eq(platformTerminalSessions.terminalId, input.terminalId))
      return true
    })
  }

  async listChunks(terminalId: string): Promise<TerminalChunkRecord[]> {
    return this.db.select().from(platformTerminalTranscriptChunks)
      .where(eq(platformTerminalTranscriptChunks.terminalId, terminalId))
      .orderBy(platformTerminalTranscriptChunks.sequence)
  }

  async listTranscriptSummaries(requesterUserId: string): Promise<OpsTranscriptSummary[]> {
    const rows = await this.db.select({
      terminal: platformTerminalSessions,
      ownerDisplayName: platformUsers.displayName,
    }).from(platformTerminalSessions)
      .innerJoin(platformUsers, eq(platformUsers.userId, platformTerminalSessions.ownerUserId))
      .orderBy(desc(platformTerminalSessions.createdAt))
      .limit(500)
    const terminalIds = rows.map(row => row.terminal.terminalId)
    const chunks = terminalIds.length
      ? await this.db.select({
        terminalId: platformTerminalTranscriptChunks.terminalId,
        chunkCount: sql<number>`COUNT(*)::integer`,
      }).from(platformTerminalTranscriptChunks)
        .where(inArray(platformTerminalTranscriptChunks.terminalId, terminalIds))
        .groupBy(platformTerminalTranscriptChunks.terminalId)
      : []
    const counts = new Map<string, number>()
    for (const chunk of chunks) counts.set(chunk.terminalId, chunk.chunkCount)
    return rows.map(row => opsTranscriptSummarySchema.parse({
      terminalId: row.terminal.terminalId,
      ownerUserId: row.terminal.ownerUserId,
      ownerDisplayName: row.ownerDisplayName,
      label: row.terminal.label,
      shell: row.terminal.shell,
      state: row.terminal.state,
      exitCode: row.terminal.exitCode,
      sizeBytes: row.terminal.recordedBytes,
      chunkCount: counts.get(row.terminal.terminalId) ?? 0,
      createdAt: row.terminal.createdAt.toISOString(),
      endedAt: row.terminal.endedAt?.toISOString() ?? null,
      retainedUntil: row.terminal.retainedUntil.toISOString(),
      ownedByRequester: row.terminal.ownerUserId === requesterUserId,
    }))
  }

  async createAccessGrant(input: {
    terminalId: string
    grantedToUserId: string
    reason: string
    expiresAt: Date
  }): Promise<string> {
    const grantId = makeId('terminal_grant')
    await this.db.insert(platformTerminalAccessGrants).values({ grantId, ...input })
    return grantId
  }

  async consumeAccessGrant(input: {
    grantId: string
    terminalId: string
    userId: string
  }): Promise<boolean> {
    const rows = await this.db.update(platformTerminalAccessGrants).set({ usedAt: new Date() })
      .where(and(
        eq(platformTerminalAccessGrants.grantId, input.grantId),
        eq(platformTerminalAccessGrants.terminalId, input.terminalId),
        eq(platformTerminalAccessGrants.grantedToUserId, input.userId),
        isNull(platformTerminalAccessGrants.usedAt),
        gt(platformTerminalAccessGrants.expiresAt, new Date()),
      )).returning({ grantId: platformTerminalAccessGrants.grantId })
    return rows.length === 1
  }

  async markMissingActiveSessionsOrphaned(activeBrokerIds: string[]): Promise<number> {
    const conditions = [inArray(platformTerminalSessions.state, ACTIVE_STATES)]
    if (activeBrokerIds.length) conditions.push(notInArray(platformTerminalSessions.terminalId, activeBrokerIds))
    const rows = await this.db.update(platformTerminalSessions).set({
      state: 'orphaned',
      endedAt: new Date(),
      failureCode: 'broker_restarted',
      failureMessage: 'Terminal Broker 已重启，PTY 不再存在。',
    }).where(and(...conditions)).returning({ terminalId: platformTerminalSessions.terminalId })
    return rows.length
  }

  async deleteExpiredSessions(now = new Date()): Promise<{ sessionCount: number; contentHashes: string[] }> {
    return this.db.transaction(async tx => {
      const expired = await tx.select({ terminalId: platformTerminalSessions.terminalId })
        .from(platformTerminalSessions)
        .where(lt(platformTerminalSessions.retainedUntil, now))
      if (!expired.length) return { sessionCount: 0, contentHashes: [] }
      const ids = expired.map(row => row.terminalId)
      const chunks = await tx.select({ contentHash: platformTerminalTranscriptChunks.contentHash })
        .from(platformTerminalTranscriptChunks)
        .where(inArray(platformTerminalTranscriptChunks.terminalId, ids))
      await tx.delete(platformTerminalSessions).where(inArray(platformTerminalSessions.terminalId, ids))
      return { sessionCount: ids.length, contentHashes: chunks.map(row => row.contentHash) }
    })
  }
}

function mapSession(
  row: typeof platformTerminalSessions.$inferSelect,
  ownerDisplayName: string,
): OpsTerminalSession {
  return opsTerminalSessionSchema.parse({
    terminalId: row.terminalId,
    ownerUserId: row.ownerUserId,
    ownerDisplayName,
    label: row.label,
    state: row.state,
    shell: row.shell,
    cols: row.currentCols,
    rows: row.currentRows,
    pid: row.pid,
    exitCode: row.exitCode,
    recordedBytes: row.recordedBytes,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    detachedAt: row.detachedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  })
}
