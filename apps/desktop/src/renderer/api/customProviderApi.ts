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
  clearCredential = false,
): Promise<CustomProviderSaveResult> {
  return requestControl('provider:custom:upsert', {
    config,
    ...(credentialHandle ? { credentialHandle } : {}),
    clearCredential,
  })
}

export function deleteCustomProvider(providerId: string): Promise<{
  deleted: boolean
  providerId: string
}> {
  return requestControl('provider:custom:delete', { providerId })
}
