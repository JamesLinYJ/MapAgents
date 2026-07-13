// +-------------------------------------------------------------------------
//
//   地理智能平台 - 资源状态 Store
//
//   文件:       resourceStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'
import type { FileEntry } from '../../api/client'
import { DEFAULT_BASEMAP } from '../../shared/constants'
import type { MapLayerPreference, UploadReference } from '../types'

interface ResourceState {
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  artifactData: Record<string, GeoJSON.FeatureCollection>
  artifactMetadata: Record<string, Record<string, unknown>>
  artifactHydrationErrors: Record<string, string>
  mapLayerPreferences: Record<string, MapLayerPreference>
  selectedArtifactId?: string
  uploadedLayerName?: string
  uploadReferences: UploadReference[]
  allFiles: FileEntry[]
  isFileSubmitting: boolean
  setBasemaps: (basemaps: BasemapDescriptor[]) => void
  setSelectedBasemapKey: (selectedBasemapKey: string) => void
  mergeArtifactData: (entries: Array<{ artifactId: string; data: GeoJSON.FeatureCollection }>) => void
  mergeArtifactMetadata: (entries: Array<{ artifactId: string; metadata: Record<string, unknown> }>) => void
  setArtifactHydrationErrors: (updater: (current: Record<string, string>) => Record<string, string>) => void
  setMapLayerPreferences: (updater: (current: Record<string, MapLayerPreference>) => Record<string, MapLayerPreference>) => void
  setSelectedArtifactId: (selectedArtifactId?: string) => void
  setUploadedLayerName: (uploadedLayerName?: string) => void
  setUploadReferences: (updater: (current: UploadReference[]) => UploadReference[]) => void
  setAllFiles: (allFiles: FileEntry[]) => void
  setIsFileSubmitting: (isFileSubmitting: boolean) => void
  clearArtifacts: () => void
  clearUploads: () => void
}

export const useResourceStore = create<ResourceState>((set) => ({
  basemaps: [DEFAULT_BASEMAP],
  selectedBasemapKey: 'osm',
  artifactData: {},
  artifactMetadata: {},
  artifactHydrationErrors: {},
  mapLayerPreferences: {},
  selectedArtifactId: undefined,
  uploadedLayerName: undefined,
  uploadReferences: [],
  allFiles: [],
  isFileSubmitting: false,
  setBasemaps: basemaps => set({ basemaps }),
  setSelectedBasemapKey: selectedBasemapKey => set({ selectedBasemapKey }),
  mergeArtifactData: entries => set(state => ({
    artifactData: {
      ...state.artifactData,
      ...Object.fromEntries(entries.map(entry => [entry.artifactId, entry.data])),
    },
  })),
  mergeArtifactMetadata: entries => set(state => ({
    artifactMetadata: {
      ...state.artifactMetadata,
      ...Object.fromEntries(entries.map(entry => [entry.artifactId, entry.metadata])),
    },
  })),
  setArtifactHydrationErrors: updater => set(state => ({
    artifactHydrationErrors: updater(state.artifactHydrationErrors),
  })),
  setMapLayerPreferences: updater => set(state => ({ mapLayerPreferences: updater(state.mapLayerPreferences) })),
  setSelectedArtifactId: selectedArtifactId => set({ selectedArtifactId }),
  setUploadedLayerName: uploadedLayerName => set({ uploadedLayerName }),
  setUploadReferences: updater => set(state => ({ uploadReferences: updater(state.uploadReferences) })),
  setAllFiles: allFiles => set({ allFiles }),
  setIsFileSubmitting: isFileSubmitting => set({ isFileSubmitting }),
  clearArtifacts: () => set({
    artifactData: {},
    artifactMetadata: {},
    artifactHydrationErrors: {},
    mapLayerPreferences: {},
    selectedArtifactId: undefined,
  }),
  clearUploads: () => set({
    uploadedLayerName: undefined,
    uploadReferences: [],
    allFiles: [],
  }),
}))
