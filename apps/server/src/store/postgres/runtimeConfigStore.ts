// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时配置存储
//
//   文件:       runtimeConfigStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { platformRuntimeConfig } from '../../db/schema.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'

// 运行时配置是平台控制面资源。这里仅负责持久化，不决定权限；
// 权限在 HTTP/WS 控制面通过 AuthorizationService 统一判断。
export class RuntimeConfigStore {
  constructor(private readonly db: Database) {}

  async getRuntimeConfig(configKey: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select({ payloadJson: platformRuntimeConfig.payloadJson })
      .from(platformRuntimeConfig)
      .where(eq(platformRuntimeConfig.configKey, configKey))
      .limit(1)
    const row = rows[0]
    return row
      ? decodeRequiredRecord(row.payloadJson, 'platform_runtime_config.payload_json')
      : null
  }

  async upsertRuntimeConfig(configKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.db
      .insert(platformRuntimeConfig)
      .values({
        configKey,
        updatedAt: new Date(),
        payloadJson: payload,
      })
      .onConflictDoUpdate({
        target: platformRuntimeConfig.configKey,
        set: {
          updatedAt: new Date(),
          payloadJson: payload,
        },
      })
    return payload
  }
}
