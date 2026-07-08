// +-------------------------------------------------------------------------
//
//   地理智能平台 - 审计事件存储
//
//   文件:       auditStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import { platformAuditEvents } from '../../db/schema.js'
import { makeId } from '../../utils/ids.js'

export interface AuditEventInput {
  actorUserId: string | null
  workspaceId: string | null
  action: string
  objectType: string
  objectId: string | null
  outcome: 'allowed' | 'denied' | 'error'
  metadata: Record<string, unknown>
}

export class AuditStore {
  constructor(private readonly db: Database) {}

  async recordEvent(input: AuditEventInput): Promise<void> {
    await this.db.insert(platformAuditEvents).values({
      auditEventId: makeId('audit'),
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      outcome: input.outcome,
      metadataJson: input.metadata,
      createdAt: new Date(),
    })
  }
}
