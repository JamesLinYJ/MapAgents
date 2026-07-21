// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维终端应用服务
//
//   文件:       terminalService.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import path from 'node:path'
import type { OpsTerminalSession, OpsTranscriptSummary } from '@geo-agent-platform/shared-types/operations'

import { makeId } from '../utils/ids.js'
import { ContentAddressedObjectStore } from '../store/contentAddressedObjectStore.js'
import { ConversationObjectGarbageCollector } from '../store/conversationObjectGarbageCollector.js'
import { PostgresObjectReferenceRepository } from '../store/postgres/objectReferenceRepository.js'
import type { AuditEventInput } from '../store/postgres/auditStore.js'
import { OPS_LIMITS, OPS_TRANSCRIPT_ACCESS_SECONDS } from './constants.js'
import type { TerminalKeyring } from './keyring.js'
import { OpsError } from './opsError.js'
import { TerminalBrokerUnavailableError, type TerminalBrokerClient } from './terminalBrokerClient.js'
import type { BrokerTerminalSession } from './brokerProtocol.js'
import { decryptTranscriptChunk } from './terminalRecording.js'
import type { TerminalRepository } from './terminalRepository.js'

export interface OpsActor {
  userId: string
  displayName: string
}

export interface OpsAuditWriter {
  recordEvent(input: AuditEventInput): Promise<void>
}

/**
 * TerminalService owns the Gateway-side transaction boundary: database identity,
 * Broker PTY state, encrypted object references, access grants and audit events.
 */
export class TerminalService {
  private readonly objectStore: ContentAddressedObjectStore
  private readonly garbageCollector: ConversationObjectGarbageCollector
  private readonly objectReferences: PostgresObjectReferenceRepository
  private brokerInfo: { shell: string; available: boolean; unavailableReason: string | null } | null = null

  constructor(private readonly input: {
    runtimeRoot: string
    repository: TerminalRepository
    broker: TerminalBrokerClient
    keyring: TerminalKeyring
    audit: OpsAuditWriter
    objectReferences: PostgresObjectReferenceRepository
  }) {
    const objectsRoot = path.join(input.runtimeRoot, 'objects', 'sha256')
    this.objectStore = new ContentAddressedObjectStore(objectsRoot)
    this.garbageCollector = new ConversationObjectGarbageCollector(
      path.join(input.runtimeRoot, 'conversations', 'sessions'),
      objectsRoot,
    )
    this.objectReferences = input.objectReferences
  }

  async initialize(): Promise<void> {
    try {
      const info = await this.input.broker.getInfo()
      if (!info.terminalAvailable || !info.shell) {
        this.brokerInfo = {
          shell: '',
          available: false,
          unavailableReason: info.unavailableReason ?? 'Terminal Broker 未配置可用 shell。',
        }
        return
      }
      this.brokerInfo = {
        shell: info.shell,
        available: true,
        unavailableReason: null,
      }
      await this.synchronizeBrokerState()
      await this.drainBrokerSpool()
    } catch (error) {
      if (!(error instanceof TerminalBrokerUnavailableError)) throw error
      this.brokerInfo = {
        shell: '',
        available: false,
        unavailableReason: 'Terminal Broker 当前不可用。',
      }
    }
  }

  availability(): { available: boolean; unavailableReason: string | null } {
    return this.brokerInfo
      ? { available: this.brokerInfo.available, unavailableReason: this.brokerInfo.unavailableReason }
      : { available: false, unavailableReason: 'Terminal Broker 尚未完成初始化。' }
  }

  list(ownerUserId?: string): Promise<OpsTerminalSession[]> {
    return this.input.repository.listSessions(ownerUserId)
  }

  async create(input: {
    actor: OpsActor
    label: string
    cols: number
    rows: number
  }): Promise<OpsTerminalSession> {
    if (!this.brokerInfo?.available || !this.brokerInfo.shell) {
      throw new OpsError('dependency_unavailable', 503, '终端功能当前不可用。')
    }
    await this.synchronizeBrokerState()
    const [ownerCount, hostCount] = await Promise.all([
      this.input.repository.countActive(input.actor.userId),
      this.input.repository.countActive(),
    ])
    if (ownerCount >= OPS_LIMITS.terminalsPerAdministrator) {
      throw new OpsError('conflict', 409, '每位管理员最多同时保留 4 个终端会话。')
    }
    if (hostCount >= OPS_LIMITS.terminalsPerHost) {
      throw new OpsError('conflict', 409, '主机最多同时保留 16 个终端会话。')
    }

    const terminalId = makeId('terminal')
    const { dataKey, wrapped } = this.input.keyring.createSessionDataKey(terminalId)
    const now = Date.now()
    await this.input.repository.insertSession({
      terminalId,
      ownerUserId: input.actor.userId,
      label: input.label,
      shell: this.brokerInfo.shell,
      cols: input.cols,
      rows: input.rows,
      expiresAt: new Date(now + OPS_LIMITS.maximumSessionSeconds * 1_000),
      retainedUntil: new Date(now + OPS_LIMITS.transcriptRetentionDays * 86_400_000),
      wrapped,
    })
    try {
      const brokerSession = await this.input.broker.createSession({
        terminalId,
        ownerUserId: input.actor.userId,
        label: input.label,
        cols: input.cols,
        rows: input.rows,
        dataKeyBase64: dataKey.toString('base64'),
      })
      await this.persistBrokerSnapshot(brokerSession)
      await this.audit(input.actor.userId, 'ops.terminal.create', terminalId, 'allowed', {
        label: input.label,
        cols: input.cols,
        rows: input.rows,
      })
    } catch (error) {
      await this.input.repository.updateSession({
        terminalId,
        state: 'failed',
        cols: input.cols,
        rows: input.rows,
        pid: null,
        exitCode: null,
        recordedBytes: 0,
        startedAt: null,
        detachedAt: null,
        endedAt: new Date(),
        failureCode: 'broker_create_failed',
        failureMessage: 'Terminal Broker 未能创建 PTY。',
      })
      await this.audit(input.actor.userId, 'ops.terminal.create', terminalId, 'error', {})
      throw error
    } finally {
      dataKey.fill(0)
    }
    const created = await this.input.repository.getSession(terminalId)
    if (!created) throw new Error('终端会话创建后未能读取。')
    return created
  }

  async terminate(actor: OpsActor, terminalId: string): Promise<OpsTerminalSession> {
    const existing = await this.requireOwnedSession(actor.userId, terminalId)
    if (!['starting', 'running', 'detached'].includes(existing.state)) return existing
    const brokerSession = await this.input.broker.terminateSession(terminalId)
    await this.persistBrokerSnapshot(brokerSession)
    await this.drainBrokerSpool()
    await this.audit(actor.userId, 'ops.terminal.close', terminalId, 'allowed', {})
    const updated = await this.input.repository.getSession(terminalId)
    if (!updated) throw new Error('终端会话关闭后未能读取。')
    return updated
  }

  async requireOwnedSession(userId: string, terminalId: string): Promise<OpsTerminalSession> {
    const session = await this.input.repository.getSession(terminalId)
    if (!session) throw new OpsError('not_found', 404, '终端会话不存在。')
    if (session.ownerUserId !== userId) {
      throw new OpsError('forbidden', 403, '不能连接其他管理员的活动终端。')
    }
    return session
  }

  openBrokerTerminal(terminalId: string) {
    return this.input.broker.openTerminal(terminalId)
  }

  async ingestBrokerSnapshot(session: BrokerTerminalSession): Promise<OpsTerminalSession> {
    await this.persistBrokerSnapshot(session)
    const updated = await this.input.repository.getSession(session.terminalId)
    if (!updated) throw new Error('Broker 返回了数据库未登记的终端会话。')
    return updated
  }

  listTranscripts(requesterUserId: string): Promise<OpsTranscriptSummary[]> {
    return this.input.repository.listTranscriptSummaries(requesterUserId)
  }

  async grantTranscriptAccess(input: {
    actor: OpsActor
    terminalId: string
    reason: string
  }): Promise<{ grantId: string; expiresAt: string }> {
    const session = await this.input.repository.getSession(input.terminalId)
    if (!session) throw new OpsError('not_found', 404, '终端记录不存在。')
    if (session.ownerUserId === input.actor.userId) {
      throw new OpsError('conflict', 409, '创建者无需申请自己的终端记录。')
    }
    const expiresAt = new Date(Date.now() + OPS_TRANSCRIPT_ACCESS_SECONDS * 1_000)
    const grantId = await this.input.repository.createAccessGrant({
      terminalId: input.terminalId,
      grantedToUserId: input.actor.userId,
      reason: input.reason,
      expiresAt,
    })
    await this.audit(input.actor.userId, 'ops.transcript.access_granted', input.terminalId, 'allowed', {
      grantId,
      reason: input.reason,
      expiresAt: expiresAt.toISOString(),
    })
    return { grantId, expiresAt: expiresAt.toISOString() }
  }

  async createCastResponse(input: {
    actor: OpsActor
    terminalId: string
    grantId?: string
    disposition: 'inline' | 'attachment'
  }): Promise<Response> {
    const secret = await this.input.repository.getSessionSecret(input.terminalId)
    if (!secret) throw new OpsError('not_found', 404, '终端记录不存在。')
    if (secret.ownerUserId !== input.actor.userId) {
      if (!input.grantId || !await this.input.repository.consumeAccessGrant({
        grantId: input.grantId,
        terminalId: input.terminalId,
        userId: input.actor.userId,
      })) throw new OpsError('forbidden', 403, '需要有效的一次性记录访问授权。')
    }
    const chunks = await this.input.repository.listChunks(input.terminalId)
    const dataKey = this.input.keyring.unwrap(input.terminalId, secret)
    const encoder = new TextEncoder()
    const objectStore = this.objectStore
    const terminalId = input.terminalId
    const header = JSON.stringify({
      version: 2,
      width: secret.initialCols,
      height: secret.initialRows,
      timestamp: Math.floor(secret.createdAt.getTime() / 1_000),
      env: { SHELL: secret.shell, TERM: 'xterm-256color' },
    })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`${header}\n`))
          for (const chunk of chunks) {
            const encrypted = await objectStore.readByHash(chunk.contentHash)
            const events = decryptTranscriptChunk({
              terminalId,
              sequence: chunk.sequence,
              dataKey,
              encrypted,
            })
            for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          dataKey.fill(0)
        }
      },
    })
    await this.audit(input.actor.userId, 'ops.transcript.read', input.terminalId, 'allowed', {
      ownerUserId: secret.ownerUserId,
      disposition: input.disposition,
      grantId: input.grantId ?? null,
    })
    const filename = `${input.terminalId}.cast`
    return new Response(stream, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/x-asciicast; charset=utf-8',
        'content-disposition': `${input.disposition}; filename="${filename}"`,
        'x-content-type-options': 'nosniff',
      },
    })
  }

  async synchronizeBrokerState(): Promise<void> {
    const sessions = await this.input.broker.listSessions()
    for (const session of sessions) {
      const registered = await this.input.repository.getSession(session.terminalId)
      if (!registered) {
        await this.input.broker.terminateSession(session.terminalId).catch(() => undefined)
        throw new Error('Terminal Broker 包含数据库未登记的 PTY，会话已被终止。')
      }
      await this.persistBrokerSnapshot(session)
    }
    await this.input.repository.markMissingActiveSessionsOrphaned(sessions.map(session => session.terminalId))
  }

  async drainBrokerSpool(): Promise<number> {
    const chunks = await this.input.broker.listChunks(500)
    let acknowledged = 0
    for (const chunk of chunks) {
      const encrypted = Buffer.from(chunk.encryptedBase64, 'base64')
      if (encrypted.byteLength !== chunk.sizeBytes) {
        throw new Error('Terminal Broker 密文分块长度与协议不一致。')
      }
      const reference = await this.objectStore.put(encrypted, 'application/vnd.geoforge.terminal-chunk')
      await this.input.repository.appendChunk({
        terminalId: chunk.terminalId,
        sequence: chunk.sequence,
        contentHash: reference.hash,
        sizeBytes: chunk.sizeBytes,
        eventCount: chunk.eventCount,
        firstEventMilliseconds: chunk.firstEventMilliseconds,
        lastEventMilliseconds: chunk.lastEventMilliseconds,
      })
      await this.input.broker.acknowledgeChunk(chunk.chunkId)
      acknowledged += 1
    }
    if (chunks.length) await this.synchronizeBrokerState()
    return acknowledged
  }

  async rewrapRetainedDataKeys(): Promise<number> {
    const records = await this.input.repository.listSessionSecrets()
    let updated = 0
    for (const record of records) {
      if (record.keyId === this.input.keyring.activeKeyId) continue
      const wrapped = this.input.keyring.rewrap(record.terminalId, record)
      if (await this.input.repository.updateWrappedDataKey(record.terminalId, record.keyId, wrapped)) updated += 1
    }
    return updated
  }

  async cleanupExpiredTranscripts(): Promise<{ sessions: number; removedObjects: number }> {
    const deleted = await this.input.repository.deleteExpiredSessions()
    if (!deleted.sessionCount) return { sessions: 0, removedObjects: 0 }
    const references = await this.objectReferences.listReferencedObjectHashes()
    const result = await this.garbageCollector.collect(references)
    await this.audit(null, 'ops.transcript.retention_cleanup', null, 'allowed', {
      sessions: deleted.sessionCount,
      removedObjects: result.removed,
    })
    return { sessions: deleted.sessionCount, removedObjects: result.removed }
  }

  private async persistBrokerSnapshot(session: BrokerTerminalSession): Promise<void> {
    await this.input.repository.updateSession({
      terminalId: session.terminalId,
      state: session.state,
      cols: session.cols,
      rows: session.rows,
      pid: session.pid,
      exitCode: session.exitCode,
      recordedBytes: session.recordedBytes,
      startedAt: session.startedAt ? new Date(session.startedAt) : null,
      detachedAt: session.detachedAt ? new Date(session.detachedAt) : null,
      endedAt: session.endedAt ? new Date(session.endedAt) : null,
      failureCode: session.failureCode,
      failureMessage: session.failureMessage,
    })
  }

  private audit(
    actorUserId: string | null,
    action: string,
    objectId: string | null,
    outcome: 'allowed' | 'denied' | 'error',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.input.audit.recordEvent({
      actorUserId,
      workspaceId: null,
      action,
      objectType: 'operations_terminal',
      objectId,
      outcome,
      metadata,
    })
  }
}
