// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider 服务
//
//   文件:       customProviderService.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  customProviderConfigSchema,
  customProviderRecordSchema,
  customProviderSaveResultSchema,
  type CustomProviderConfig,
  type CustomProviderRecord,
  type CustomProviderSaveResult,
} from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type {
  CustomProviderStore,
  StoredCustomProvider,
} from '../store/postgres/customProviderStore.js'
import {
  ProviderCredentialCipher,
  ProviderCredentialStagingService,
} from './customProviderCredentials.js'
import type { ModelAdapter, ModelAdapterRegistry } from './registry.js'
import { MODEL_PROVIDER_IDS } from './registry.js'
import { createCustomOpenAIAdapter } from './providers/customOpenAI.js'

type CustomProviderRepository = Pick<CustomProviderStore, 'list' | 'get' | 'upsert' | 'delete'>
type CustomProviderRegistry = Pick<ModelAdapterRegistry, 'installCustom' | 'removeCustom' | 'descriptors'>
type AdapterFactory = (input: { config: CustomProviderConfig; apiKey: string }) => ModelAdapter

export class CustomProviderService {
  constructor(
    private readonly repository: CustomProviderRepository,
    private readonly registry: CustomProviderRegistry,
    private readonly cipher: ProviderCredentialCipher,
    readonly credentials: ProviderCredentialStagingService,
    private readonly adapterFactory: AdapterFactory = createCustomOpenAIAdapter,
  ) {}

  async loadPersistedProviders(): Promise<void> {
    for (const stored of await this.repository.list()) {
      const apiKey = stored.credential
        ? this.cipher.decrypt(stored.providerId, stored.credential)
        : ''
      await this.registry.installCustom(this.adapterFactory({ config: publicConfig(stored), apiKey }))
    }
  }

  async list(): Promise<CustomProviderRecord[]> {
    return (await this.repository.list()).map(publicRecord)
  }

  async save(input: {
    config: CustomProviderConfig
    credentialHandle?: string | null
    clearCredential?: boolean
    auth: AuthContext
  }): Promise<CustomProviderSaveResult> {
    const config = customProviderConfigSchema.parse(input.config)
    if (MODEL_PROVIDER_IDS.includes(config.providerId as (typeof MODEL_PROVIDER_IDS)[number])) {
      throw new Error(`Provider ID '${config.providerId}' 已由内置适配器使用。`)
    }
    const existing = await this.repository.get(config.providerId)
    const secret = input.credentialHandle
      ? this.credentials.resolve(input.credentialHandle, input.auth)
      : input.clearCredential
        ? ''
        : existing?.credential
          ? this.cipher.decrypt(config.providerId, existing.credential)
          : ''
    const candidate = this.adapterFactory({ config, apiKey: secret })
    const startedAt = performance.now()
    let installed = false
    try {
      await candidate.warmup?.()
      const response = await candidate.chat('Reply with exactly OK.', {
        model: config.defaultModel,
        reasoning: false,
        maxOutputTokens: 8,
      })
      if (typeof response.content !== 'string' || !response.content.trim()) {
        throw new Error('最小模型调用没有返回文本内容。')
      }
      const testedAt = new Date().toISOString()
      const credential = input.credentialHandle
        ? this.cipher.encrypt(config.providerId, secret)
        : input.clearCredential
          ? null
          : existing?.credential ?? null
      const stored = await this.repository.upsert({
        ...config,
        credential,
        createdByUserId: existing?.createdByUserId ?? input.auth.userId,
        lastValidatedAt: testedAt,
      })
      await this.registry.installCustom(candidate)
      installed = true
      if (input.credentialHandle) this.credentials.consume(input.credentialHandle, input.auth)
      const descriptor = this.registry.descriptors().find(item => item.provider === config.providerId)
      if (!descriptor) throw new Error(`自定义 Provider '${config.providerId}' 注册后没有描述信息。`)
      return customProviderSaveResultSchema.parse({
        provider: publicRecord(stored),
        descriptor,
        validation: {
          connectivityOk: true,
          modelCallOk: true,
          testedModel: config.defaultModel,
          latencyMs: elapsedMilliseconds(startedAt),
          testedAt,
        },
      })
    } finally {
      if (!installed) await candidate.close?.().catch(() => undefined)
    }
  }

  async delete(providerId: string): Promise<boolean> {
    if (MODEL_PROVIDER_IDS.includes(providerId as (typeof MODEL_PROVIDER_IDS)[number])) {
      throw new Error('不能删除内置模型 Provider。')
    }
    const deleted = await this.repository.delete(providerId)
    if (deleted) await this.registry.removeCustom(providerId)
    return deleted
  }
}

function publicConfig(stored: StoredCustomProvider): CustomProviderConfig {
  return customProviderConfigSchema.parse({
    providerId: stored.providerId,
    displayName: stored.displayName,
    baseUrl: stored.baseUrl,
    protocol: stored.protocol,
    models: stored.models,
    defaultModel: stored.defaultModel,
    toolSchemaMode: stored.toolSchemaMode,
    networkAccess: stored.networkAccess,
  })
}

function publicRecord(stored: StoredCustomProvider): CustomProviderRecord {
  return customProviderRecordSchema.parse({
    ...publicConfig(stored),
    hasApiKey: Boolean(stored.credential),
    createdByUserId: stored.createdByUserId,
    lastValidatedAt: stored.lastValidatedAt,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  })
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
