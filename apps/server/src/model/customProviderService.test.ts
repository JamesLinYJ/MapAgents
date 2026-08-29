import { describe, expect, it, vi } from 'vitest'

import type { CustomProviderConfig } from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type { StoredCustomProvider } from '../store/postgres/customProviderStore.js'
import {
  ProviderCredentialPersistence,
  ProviderCredentialStagingService,
} from './customProviderCredentials.js'
import { CustomProviderService } from './customProviderService.js'
import { resolveAdapterModelCapabilities, type ModelAdapter } from './registry.js'

describe('CustomProviderService', () => {
  it('tests before saving, persists the plaintext credential, and installs through the registry', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const registry = registryFor(installed)
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const staged = credentials.stage('sk-sensitive-provider-key', auth)
    const chat = vi.fn(async () => ({ content: 'OK' }))
    const service = new CustomProviderService(
      repository,
      registry,
      new ProviderCredentialPersistence(),
      credentials,
      () => adapter(chat),
    )

    const result = await service.save({ config: config(), credentialHandle: staged.credentialHandle, auth })

    expect(chat).toHaveBeenCalledWith('Reply with exactly OK.', {
      model: 'model-1',
      reasoning: false,
      maxOutputTokens: 128,
    })
    expect(result.provider.hasApiKey).toBe(true)
    expect(result.validation).toMatchObject({ connectivityOk: true, modelCallOk: true })
    expect(result.provider.models).toEqual([
      expect.objectContaining({ modelId: 'model-1', contextWindowTokens: 128_000, modalities: ['text', 'image'] }),
      expect.objectContaining({ modelId: 'model-2', contextWindowTokens: 32_000, modalities: ['text'] }),
    ])
    expect(installed).toHaveLength(1)
    expect(records.get('my-provider')?.credential?.value).toBe('sk-sensitive-provider-key')
    expect(() => credentials.resolve(staged.credentialHandle, auth)).toThrow('不存在或已经过期')
  })

  it('does not persist or install a provider when the minimal model call fails', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const service = new CustomProviderService(
      repository,
      registryFor(installed),
      new ProviderCredentialPersistence(),
      new ProviderCredentialStagingService(),
      () => adapter(vi.fn(async () => { throw new Error('provider unavailable') })),
    )

    await expect(service.save({ config: config(), auth: fakeAuth() })).rejects.toThrow('provider unavailable')
    expect(records.size).toBe(0)
    expect(installed).toHaveLength(0)
  })

  it('discovers models with the stored credential or a staged replacement without consuming it', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const persistence = new ProviderCredentialPersistence()
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const storedConfig = config()
    const now = new Date().toISOString()
    records.set(storedConfig.providerId, {
      ...storedConfig,
      credential: persistence.store('stored-secret'),
      createdByUserId: auth.userId,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    const discovery = vi.fn(async () => ({
      models: [{ modelId: 'model-1', ownedBy: 'provider' }],
      latencyMs: 12,
      testedAt: now,
    }))
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor([]),
      persistence,
      credentials,
      () => adapter(vi.fn(async () => ({ content: 'OK' }))),
      discovery,
    )

    await service.discoverModels({
      providerId: storedConfig.providerId,
      baseUrl: storedConfig.baseUrl,
      networkAccess: storedConfig.networkAccess,
      auth,
    })
    expect(discovery).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'stored-secret' }))

    const staged = credentials.stage('replacement-secret', auth)
    await service.discoverModels({
      providerId: storedConfig.providerId,
      baseUrl: storedConfig.baseUrl,
      networkAccess: storedConfig.networkAccess,
      credentialHandle: staged.credentialHandle,
      auth,
    })
    expect(discovery).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'replacement-secret' }))
    expect(credentials.resolve(staged.credentialHandle, auth)).toBe('replacement-secret')
  })

  it('retains, replaces, and explicitly clears a saved API key', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const persistence = new ProviderCredentialPersistence()
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const usedSecrets: string[] = []
    const installed: ModelAdapter[] = []
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor(installed),
      persistence,
      credentials,
      ({ apiKey }) => {
        usedSecrets.push(apiKey)
        return adapter(vi.fn(async () => ({ content: 'OK' })))
      },
    )

    const original = credentials.stage('original-secret', auth)
    await service.save({ config: config(), credentialHandle: original.credentialHandle, auth })
    const originalCredential = records.get('my-provider')?.credential
    expect(originalCredential).not.toBeNull()

    await service.save({ config: config({ displayName: 'Renamed' }), auth })
    expect(records.get('my-provider')?.credential).toEqual(originalCredential)

    const replacement = credentials.stage('replacement-secret', auth)
    await service.save({
      config: config(),
      credentialHandle: replacement.credentialHandle,
      auth,
    })
    expect(persistence.read(records.get('my-provider')!.credential!))
      .toBe('replacement-secret')

    const cleared = await service.save({ config: config(), clearApiKey: true, auth })
    expect(cleared.provider.hasApiKey).toBe(false)
    expect(records.get('my-provider')?.credential).toBeNull()
    expect(usedSecrets).toEqual([
      'original-secret',
      'original-secret',
      'replacement-secret',
      '',
    ])

    const conflicting = credentials.stage('conflicting-secret', auth)
    await expect(service.save({
      config: config(),
      credentialHandle: conflicting.credentialHandle,
      clearApiKey: true,
      auth,
    })).rejects.toThrow('不能同时使用')
  })

  it('serializes mutations per provider without blocking a different provider', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const installed: ModelAdapter[] = []
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    const created: string[] = []
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor(installed),
      new ProviderCredentialPersistence(),
      new ProviderCredentialStagingService(),
      ({ config: providerConfig }) => {
        created.push(providerConfig.displayName)
        return adapter(vi.fn(async () => {
          if (providerConfig.displayName === 'First') {
            firstStarted.resolve(undefined)
            await releaseFirst.promise
          }
          return { content: 'OK' }
        }), providerConfig.providerId, providerConfig.displayName)
      },
    )
    const auth = fakeAuth()

    const firstSave = service.save({ config: config({ displayName: 'First' }), auth })
    await firstStarted.promise
    const secondSave = service.save({ config: config({ displayName: 'Second' }), auth })
    const otherSave = service.save({
      config: config({ providerId: 'other-provider', displayName: 'Other' }),
      auth,
    })

    await otherSave
    expect(created).toEqual(['First', 'Other'])
    releaseFirst.resolve(undefined)
    await Promise.all([firstSave, secondSave])

    expect(created).toEqual(['First', 'Other', 'Second'])
    expect(records.get('my-provider')?.displayName).toBe('Second')
    expect(records.get('other-provider')?.displayName).toBe('Other')
  })

  it('orders deletion after an in-flight save for the same provider', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const registry = registryFor(installed)
    const saveStarted = deferred<void>()
    const releaseSave = deferred<void>()
    const service = new CustomProviderService(
      repository,
      registry,
      new ProviderCredentialPersistence(),
      new ProviderCredentialStagingService(),
      ({ config: providerConfig }) => adapter(vi.fn(async () => {
        saveStarted.resolve(undefined)
        await releaseSave.promise
        return { content: 'OK' }
      }), providerConfig.providerId, providerConfig.displayName),
    )

    const save = service.save({ config: config(), auth: fakeAuth() })
    await saveStarted.promise
    const deletion = service.delete('my-provider')
    await Promise.resolve()

    expect(repository.delete).not.toHaveBeenCalled()
    releaseSave.resolve(undefined)
    await expect(save).resolves.toBeDefined()
    await expect(deletion).resolves.toBe(true)
    expect(records.has('my-provider')).toBe(false)
    expect(registry.removeCustom).toHaveBeenCalledWith('my-provider')
  })

  it('resolves context, modalities, and capabilities from the selected model snapshot', () => {
    const candidate = adapter(vi.fn(async () => ({ content: 'OK' })))

    expect(resolveAdapterModelCapabilities(candidate, 'model-2')).toEqual({
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    })
  })
})

function repositoryFor(records: Map<string, StoredCustomProvider>) {
  return {
    list: vi.fn(async () => [...records.values()]),
    get: vi.fn(async (providerId: string) => records.get(providerId) ?? null),
    upsert: vi.fn(async (record: Omit<StoredCustomProvider, 'createdAt' | 'updatedAt'>) => {
      const now = new Date().toISOString()
      const saved = { ...record, createdAt: records.get(record.providerId)?.createdAt ?? now, updatedAt: now }
      records.set(record.providerId, saved)
      return saved
    }),
    delete: vi.fn(async (providerId: string) => records.delete(providerId)),
  }
}

function registryFor(installed: ModelAdapter[]) {
  return {
    installCustom: vi.fn(async (candidate: ModelAdapter) => { installed.push(candidate) }),
    removeCustom: vi.fn(async () => true),
    descriptors: vi.fn(() => installed.map(candidate => ({
      provider: candidate.provider,
      displayName: candidate.displayName,
      configured: true,
      source: 'custom' as const,
      defaultModel: candidate.defaultModel,
      availableModels: [...(candidate.availableModels ?? [])],
      models: [...(candidate.modelCapabilitySnapshots ?? [])],
      capabilities: candidate.capabilities(),
      modalities: ['text' as const],
      protocol: 'responses' as const,
      contextWindowTokens: candidate.contextWindowTokens ?? 128_000,
      agentRuntime: candidate.agentRuntimeCapabilities,
    }))),
  }
}

function adapter(
  chat: ModelAdapter['chat'],
  provider = 'my-provider',
  displayName = 'My Provider',
): ModelAdapter {
  return {
    provider,
    displayName,
    source: 'custom',
    defaultModel: 'model-1',
    availableModels: ['model-1', 'model-2'],
    modelCapabilitySnapshots: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }, {
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    }],
    contextWindowTokens: 128_000,
    modalities: ['text'],
    protocol: 'responses',
    agentToolSchemaMode: 'compatible',
    agentRuntimeCapabilities: {
      transport: 'openai_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['chat'],
    warmup: vi.fn(async () => undefined),
    chat,
    close: vi.fn(async () => undefined),
  }
}

function config(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    providerId: 'my-provider',
    displayName: 'My Provider',
    baseUrl: 'https://api.provider.com/v1',
    protocol: 'responses',
    models: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    }, {
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    defaultModel: 'model-1',
    toolSchemaMode: 'compatible',
    networkAccess: 'public',
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function fakeAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: 'User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'platform_admin' }],
  }
}
