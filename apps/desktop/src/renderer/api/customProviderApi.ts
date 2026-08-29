// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider API
//
//   文件:       customProviderApi.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  CustomProviderConfig,
  CustomProviderRecord,
  CustomProviderSaveResult,
  ProviderModelDiscovery,
} from '@geo-agent-platform/shared-types'

import { requestControl } from './transport'

export function listCustomProviders(): Promise<CustomProviderRecord[]> {
  return requestControl('provider:custom:list')
}

export function stageProviderCredential(secret: string): Promise<{
  credentialHandle: string
  expiresAt: string
}> {
  return requestControl('provider:credential:stage', { secret })
}

export function saveCustomProvider(
  config: CustomProviderConfig,
  credentialHandle?: string | null,
  clearApiKey = false,
): Promise<CustomProviderSaveResult> {
  return requestControl('provider:custom:upsert', {
    config,
    ...(credentialHandle ? { credentialHandle } : {}),
    clearApiKey,
  })
}

export function discoverCustomProviderModels(input: {
  providerId: string
  baseUrl: string
  networkAccess: CustomProviderConfig['networkAccess']
  credentialHandle?: string | null
}): Promise<ProviderModelDiscovery> {
  return requestControl('provider:custom:discover-models', {
    providerId: input.providerId,
    baseUrl: input.baseUrl,
    networkAccess: input.networkAccess,
    ...(input.credentialHandle ? { credentialHandle: input.credentialHandle } : {}),
  })
}

export function deleteCustomProvider(providerId: string): Promise<{
  deleted: boolean
  providerId: string
}> {
  return requestControl('provider:custom:delete', { providerId })
}
