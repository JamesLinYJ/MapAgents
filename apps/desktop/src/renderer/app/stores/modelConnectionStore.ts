// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型连接状态 Store
//
//   文件:       modelConnectionStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'
import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'

interface ModelConnectionState {
  providers: ModelProviderDescriptor[]
  provider: string
  model: string
  applyProviders: (providers: ModelProviderDescriptor[]) => void
  changeProvider: (provider: string) => void
  setProvider: (provider: string) => void
  setModel: (model: string) => void
}

export const useModelConnectionStore = create<ModelConnectionState>((set, get) => ({
  providers: [],
  provider: 'deepseek',
  model: '',
  applyProviders: providers => {
    const currentProvider = get().provider
    const currentModel = get().model
    const current = providers.find(item => (
      item.provider === currentProvider && supportsAgentSdkLiveSupervisor(item)
    ))
    const preferred =
      current ??
      providers.find(item => item.provider === 'deepseek' && supportsAgentSdkLiveSupervisor(item)) ??
      providers.find(item => supportsAgentSdkLiveSupervisor(item)) ??
      (providers.length > 0 ? providers[0] : undefined)
    const availableModels = preferred
      ? new Set([preferred.defaultModel, ...preferred.availableModels].filter(Boolean))
      : new Set<string>()
    set({
      providers,
      ...(preferred ? {
        provider: preferred.provider,
        model: preferred.provider === currentProvider && availableModels.has(currentModel)
          ? currentModel
          : preferred.defaultModel ?? '',
      } : {}),
    })
  },
  changeProvider: provider => {
    const selected = get().providers.find(item => item.provider === provider)
    set({ provider, model: selected?.defaultModel ?? '' })
  },
  setProvider: provider => set({ provider }),
  setModel: model => set({ model }),
}))
