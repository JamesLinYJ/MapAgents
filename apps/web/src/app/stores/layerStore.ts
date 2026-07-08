// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层状态 Store
//
//   文件:       layerStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'
import {
  deleteLayer,
  importManagedLayer,
  listLayers,
  replaceManagedLayer,
  updateLayer,
} from '../../api/client'

interface LayerState {
  layers: LayerDescriptor[]
  setLayers: (layers: LayerDescriptor[]) => void
  refreshLayers: (sessionId?: string | null, threadId?: string | null) => Promise<LayerDescriptor[]>
  importLayer: (file: File) => Promise<LayerDescriptor[]>
  toggleLayerStatus: (layerKey: string, nextStatus: string) => Promise<LayerDescriptor[]>
  replaceLayer: (layerKey: string, file: File) => Promise<LayerDescriptor[]>
  removeLayer: (layerKey: string) => Promise<LayerDescriptor[]>
}

export const useLayerStore = create<LayerState>((set, get) => ({
  layers: [],
  setLayers: layers => set({ layers }),
  refreshLayers: async (sessionId, threadId) => {
    const layers = await listLayers(sessionId, threadId)
    set({ layers })
    return layers
  },
  importLayer: async file => {
    await importManagedLayer(file)
    return get().refreshLayers()
  },
  toggleLayerStatus: async (layerKey, nextStatus) => {
    await updateLayer(layerKey, { status: nextStatus })
    return get().refreshLayers()
  },
  replaceLayer: async (layerKey, file) => {
    await replaceManagedLayer(layerKey, file)
    return get().refreshLayers()
  },
  removeLayer: async layerKey => {
    await deleteLayer(layerKey)
    return get().refreshLayers()
  },
}))
