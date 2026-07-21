// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维审计缓冲服务
//
//   文件:       opsAuditService.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AuditEventInput, AuditStore } from '../store/postgres/auditStore.js'
import { isDatabaseUnavailable } from '../db/databaseAvailability.js'

const MAX_PENDING_AUDIT_EVENTS = 10_000

/** 数据库短暂中断期间保留运维审计；恢复后严格按顺序补写。 */
export class OpsAuditService {
  private readonly pending: AuditEventInput[] = []
  private flushChain: Promise<void> = Promise.resolve()

  constructor(private readonly store: AuditStore) {}

  async recordEvent(event: AuditEventInput): Promise<void> {
    try {
      await this.flush()
      await this.store.recordEvent(event)
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error
      if (this.pending.length >= MAX_PENDING_AUDIT_EVENTS) {
        throw new Error('运维审计缓冲已满，已拒绝继续执行写操作。')
      }
      this.pending.push(structuredClone(event))
    }
  }

  flush(): Promise<void> {
    this.flushChain = this.flushChain.catch(() => undefined).then(async () => {
      while (this.pending.length) {
        const event = this.pending[0]
        if (!event) break
        await this.store.recordEvent(event)
        this.pending.shift()
      }
    })
    return this.flushChain
  }

  pendingCount(): number {
    return this.pending.length
  }
}
