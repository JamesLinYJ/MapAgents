// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider 存储
//
//   文件:       customProviderStore.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { asc, eq } from 'drizzle-orm'
import {
  customProviderConfigSchema,
  type CustomProviderConfig,
} from '@geo-agent-platform/shared-types'

import type { Database } from '../../db/connection.js'
import { platformModelProviders } from '../../db/schema.js'

type CustomProviderRow = typeof platformModelProviders.$inferSelect

export interface EncryptedProviderCredential {
  ciphertext: string
  iv: string
  authTag: string
  keyVersion: string
}

export interface StoredCustomProvider extends CustomProviderConfig {
  credential: EncryptedProviderCredential | null
  createdByUserId: string
  lastValidatedAt: string
  createdAt: string
  updatedAt: string
}

export class CustomProviderStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<StoredCustomProvider[]> {
    const rows = await this.db
      .select()
      .from(platformModelProviders)
      .orderBy(asc(platformModelProviders.providerId))
    return rows.map(mapRow)
  }

  async get(providerId: string): Promise<StoredCustomProvider | null> {
    const rows = await this.db
      .select()
      .from(platformModelProviders)
      .where(eq(platformModelProviders.providerId, providerId))
      .limit(1)
    return rows[0] ? mapRow(rows[0]) : null
  }

  async upsert(record: Omit<StoredCustomProvider, 'createdAt' | 'updatedAt'>): Promise<StoredCustomProvider> {
    const now = new Date()
    const credential = credentialColumns(record.credential)
    const rows = await this.db
      .insert(platformModelProviders)
      .values({
        providerId: record.providerId,
        displayName: record.displayName,
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        modelsJson: record.models,
        defaultModel: record.defaultModel,
        toolSchemaMode: record.toolSchemaMode,
        networkAccess: record.networkAccess,
        ...credential,
        createdByUserId: record.createdByUserId,
        lastValidatedAt: new Date(record.lastValidatedAt),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: platformModelProviders.providerId,
        set: {
          displayName: record.displayName,
          baseUrl: record.baseUrl,
          protocol: record.protocol,
          modelsJson: record.models,
          defaultModel: record.defaultModel,
          toolSchemaMode: record.toolSchemaMode,
          networkAccess: record.networkAccess,
          ...credential,
          lastValidatedAt: new Date(record.lastValidatedAt),
          updatedAt: now,
        },
      })
      .returning()
    const saved = rows[0]
    if (!saved) throw new Error(`自定义 Provider '${record.providerId}' 保存后未返回记录。`)
    return mapRow(saved)
  }

  async delete(providerId: string): Promise<boolean> {
    const rows = await this.db
      .delete(platformModelProviders)
      .where(eq(platformModelProviders.providerId, providerId))
      .returning({ providerId: platformModelProviders.providerId })
    return rows.length > 0
  }
}

function mapRow(row: CustomProviderRow): StoredCustomProvider {
  const config = customProviderConfigSchema.parse({
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    models: row.modelsJson,
    defaultModel: row.defaultModel,
    toolSchemaMode: row.toolSchemaMode,
    networkAccess: row.networkAccess,
  })
  return {
    ...config,
    credential: readCredential(row),
    createdByUserId: row.createdByUserId,
    lastValidatedAt: row.lastValidatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function readCredential(row: CustomProviderRow): EncryptedProviderCredential | null {
  const fields = [row.apiKeyCiphertext, row.apiKeyIv, row.apiKeyAuthTag, row.credentialKeyVersion]
  if (fields.every(value => value === null)) return null
  if (fields.some(value => value === null)) {
    throw new Error(`自定义 Provider '${row.providerId}' 的加密凭据字段不完整。`)
  }
  return {
    ciphertext: row.apiKeyCiphertext as string,
    iv: row.apiKeyIv as string,
    authTag: row.apiKeyAuthTag as string,
    keyVersion: row.credentialKeyVersion as string,
  }
}

function credentialColumns(credential: EncryptedProviderCredential | null) {
  return credential
    ? {
        apiKeyCiphertext: credential.ciphertext,
        apiKeyIv: credential.iv,
        apiKeyAuthTag: credential.authTag,
        credentialKeyVersion: credential.keyVersion,
      }
    : {
        apiKeyCiphertext: null,
        apiKeyIv: null,
        apiKeyAuthTag: null,
        credentialKeyVersion: null,
      }
}
