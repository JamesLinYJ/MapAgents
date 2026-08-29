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
  customProviderIdSchema,
  customProviderRecordSchema,
  customProviderSaveResultSchema,
  type CustomProviderConfig,
  type CustomProviderRecord,
  type CustomProviderSaveResult,
  type ProviderModelDiscovery,
} from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type {
  CustomProviderStore,
  StoredCustomProvider,
} from '../store/postgres/customProviderStore.js'
import {
  ProviderCredentialPersistence,
  ProviderCredentialStagingService,
} from './customProviderCredentials.js'
import type { ModelAdapter, ModelAdapterRegistry } from './registry.js'
import {
  CONFIGURABLE_BUILTIN_PROVIDER_IDS,
  MODEL_PROVIDER_IDS,
} from './registry.js'
import { createCustomOpenAIAdapter } from './providers/customOpenAI.js'
import {
  discoverCustomProviderModels,
  type CustomProviderModelDiscoveryInput,
} from './customProviderModelDiscovery.js'

type CustomProviderRepository = Pick<CustomProviderStore, 'list' | 'get' | 'upsert' | 'delete'>
type CustomProviderRegistry = Pick<ModelAdapterRegistry, 'installCustom' | 'removeCustom' | 'descriptors'>
type AdapterFactory = (input: { config: CustomProviderConfig; apiKey: string }) => ModelAdapter
type ModelDiscovery = (input: CustomProviderModelDiscoveryInput) => Promise<ProviderModelDiscovery>

// 推理模型会先消耗一部分输出词元生成内部推理；预算过小会在正文出现前被截断。
const MINIMAL_MODEL_CALL_OUTPUT_TOKENS = 128

export class CustomProviderService {
  private readonly providerMutationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly repository: CustomProviderRepository,
    private readonly registry: CustomProviderRegistry,
    private readonly credentialPersistence: ProviderCredentialPersistence,
    readonly credentials: ProviderCredentialStagingService,
    private readonly adapterFactory: AdapterFactory = createCustomOpenAIAdapter,
    private readonly modelDiscovery: ModelDiscovery = discoverCustomProviderModels,
  ) {}

  async loadPersistedProviders(): Promise<void> {
    for (const stored of await this.repository.list()) {
      const apiKey = stored.credential
        ? this.credentialPersistence.read(stored.credential)
        : ''
      await this.registry.installCustom(this.adapterFactory({ config: publicConfig(stored), apiKey }))
    }
  }

  async list(): Promise<CustomProviderRecord[]> {
    return (await this.repository.list()).map(publicRecord)
  }

  async discoverModels(input: {
    providerId: string
    baseUrl: string
    networkAccess: CustomProviderConfig['networkAccess']
    credentialHandle?: string | null
    auth: AuthContext
  }): Promise<ProviderModelDiscovery> {
    const providerId = customProviderIdSchema.parse(input.providerId)
    const existing = await this.repository.get(providerId)
    const apiKey = input.credentialHandle
      ? this.credentials.resolve(input.credentialHandle, input.auth)
      : existing?.credential
        ? this.credentialPersistence.read(existing.credential)
        : ''
    return this.modelDiscovery({
      baseUrl: input.baseUrl,
      networkAccess: input.networkAccess,
      apiKey,
    })
  }

  async save(input: {
    config: CustomProviderConfig
    credentialHandle?: string | null
    clearApiKey?: boolean
    clearCredential?: boolean
    auth: AuthContext
  }): Promise<CustomProviderSaveResult> {
    const config = customProviderConfigSchema.parse(input.config)
    if (input.credentialHandle && (input.clearApiKey || input.clearCredential)) {
      throw new Error('新 API Key 与清除操作不能同时使用。')
    }
    if (isNonConfigurableBuiltin(config.providerId)) {
      throw new Error(`内置 Provider '${config.providerId}' 不支持在设置页覆盖。`)
    }
    return this.runProviderMutation(config.providerId, async () => {
      const existing = await this.repository.get(config.providerId)
      const clearApiKey = Boolean(input.clearApiKey || input.clearCredential)
      const secret = input.credentialHandle
        ? this.credentials.resolve(input.credentialHandle, input.auth)
        : clearApiKey
          ? ''
          : existing?.credential
            ? this.credentialPersistence.read(existing.credential)
            : ''
      const candidate = this.adapterFactory({ config, apiKey: secret })
      const startedAt = performance.now()
      let installed = false
      try {
        await candidate.warmup?.()
        const response = await candidate.chat('Reply with exactly OK.', {
          model: config.defaultModel,
          reasoning: false,
          maxOutputTokens: MINIMAL_MODEL_CALL_OUTPUT_TOKENS,
        })
        if (typeof response.content !== 'string' || !response.content.trim()) {
          throw new Error('最小模型调用没有返回文本内容。')
        }
        const testedAt = new Date().toISOString()
        const credential = input.credentialHandle
          ? this.credentialPersistence.store(secret)
          : clearApiKey
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
    })
  }

  async delete(providerId: string): Promise<boolean> {
    if (isNonConfigurableBuiltin(providerId)) throw new Error('不能删除该内置模型 Provider。')
    return this.runProviderMutation(providerId, async () => {
      const deleted = await this.repository.delete(providerId)
      if (deleted) await this.registry.removeCustom(providerId)
      return deleted
    })
  }

  private runProviderMutation<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.providerMutationTails.get(providerId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.providerMutationTails.set(providerId, tail)
    void tail.then(() => {
      if (this.providerMutationTails.get(providerId) === tail) {
        this.providerMutationTails.delete(providerId)
      }
    })
    return result
  }
}

function isNonConfigurableBuiltin(providerId: string): boolean {
  return MODEL_PROVIDER_IDS.includes(providerId as (typeof MODEL_PROVIDER_IDS)[number])
    && !CONFIGURABLE_BUILTIN_PROVIDER_IDS.includes(
      providerId as (typeof CONFIGURABLE_BUILTIN_PROVIDER_IDS)[number],
    )
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
