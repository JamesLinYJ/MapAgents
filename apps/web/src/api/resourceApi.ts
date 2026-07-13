// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件、图层、Artifact 与气象数据 API
//
//   文件:       resourceApi.ts
// --------------------------------------------------------------------------

import {
  basemapDescriptorSchema,
  layerDescriptorSchema,
  meteorologicalDatasetRecordSchema,
  meteorologicalJobRecordSchema,
  type BasemapDescriptor,
  type LayerDescriptor,
  type MeteorologicalDatasetRecord,
  type MeteorologicalJobRecord,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import { unknownRecordSchema } from './responseSchemas'
import { requestControl, requestFormJson, requestJson } from './transport'

export interface FileEntry {
  id: string
  name: string
  size: string
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId?: string | null
  relativePath?: string
  sourceRelativePath?: string | null
}

export interface FileListResponse {
  files: FileEntry[]
  total: number
}

const geoJsonFeatureCollectionSchema = z.custom<GeoJSON.FeatureCollection>(value => (
  typeof value === 'object'
  && value !== null
  && 'type' in value
  && value.type === 'FeatureCollection'
  && 'features' in value
  && Array.isArray(value.features)
), '预期为 GeoJSON FeatureCollection')

const meteorologicalUploadResponseSchema = z.object({
  dataset: meteorologicalDatasetRecordSchema,
  job: meteorologicalJobRecordSchema.nullable(),
})

const fileEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number().nonnegative(),
  uploadedAt: z.string(),
  status: z.string(),
  threadId: z.string().nullable().optional(),
  relativePath: z.string().optional(),
  sourceRelativePath: z.string().nullable().optional(),
})

const fileListResponseSchema = z.object({
  files: z.array(fileEntrySchema),
  total: z.number().int().nonnegative(),
})

const uploadedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number().nonnegative(),
  sourceRelativePath: z.string().nullable().optional(),
})

const deletedFileSchema = z.object({ deleted: z.boolean(), id: z.string() })
const deletedLayerSchema = z.object({ deleted: z.boolean(), layerKey: z.string() })

export function listLayers(sessionId?: string | null, threadId?: string | null): Promise<LayerDescriptor[]> {
  return requestControl('layer:list', { sessionId, threadId }, z.array(layerDescriptorSchema))
}

export function updateLayer(layerKey: string, payload: Record<string, unknown>): Promise<LayerDescriptor> {
  return requestControl('layer:update', { layerKey, update: payload }, layerDescriptorSchema)
}

export function deleteLayer(layerKey: string): Promise<z.infer<typeof deletedLayerSchema>> {
  return requestControl('layer:delete', { layerKey }, deletedLayerSchema)
}

export function listBasemaps(): Promise<BasemapDescriptor[]> {
  return requestJson('/api/v1/map/basemaps', undefined, 30_000, z.array(basemapDescriptorSchema))
}

export function getArtifactGeoJson(artifactId: string): Promise<GeoJSON.FeatureCollection> {
  return requestJson(
    `/api/v1/results/${encodeURIComponent(artifactId)}/geojson`,
    undefined,
    30_000,
    geoJsonFeatureCollectionSchema,
  )
}

export function getArtifactMetadata(artifactId: string): Promise<Record<string, unknown>> {
  return requestJson(
    `/api/v1/results/${encodeURIComponent(artifactId)}/metadata`,
    undefined,
    30_000,
    unknownRecordSchema,
  )
}

export async function uploadLayer(
  sessionId: string,
  file: File,
  threadId?: string | null,
  sourceRelativePath?: string | null,
): Promise<LayerDescriptor> {
  const formData = new FormData()
  formData.append('session_id', sessionId)
  if (threadId) formData.append('threadId', threadId)
  if (sourceRelativePath) formData.append('sourceRelativePath', sourceRelativePath)
  formData.append('file', file)
  return requestFormJson('/api/v1/layers/register', formData, '图层上传请求失败', 120_000, layerDescriptorSchema)
}

export async function uploadMeteorologicalDataset(
  sessionId: string,
  file: File,
  threadId?: string | null,
  sourceRelativePath?: string | null,
): Promise<{ dataset: MeteorologicalDatasetRecord; job: MeteorologicalJobRecord | null }> {
  const formData = new FormData()
  formData.append('sessionId', sessionId)
  if (threadId) formData.append('threadId', threadId)
  if (sourceRelativePath) formData.append('sourceRelativePath', sourceRelativePath)
  formData.append('file', file)
  return requestFormJson(
    '/api/v1/meteorology/datasets',
    formData,
    '气象数据上传请求失败',
    600_000,
    meteorologicalUploadResponseSchema,
  )
}

export function listMeteorologicalDatasets(
  sessionId?: string | null,
  threadId?: string | null,
): Promise<MeteorologicalDatasetRecord[]> {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  if (threadId) params.set('threadId', threadId)
  const query = params.toString()
  return requestJson(
    `/api/v1/meteorology/datasets${query ? `?${query}` : ''}`,
    undefined,
    30_000,
    z.array(meteorologicalDatasetRecordSchema),
  )
}

export function getMeteorologicalJob(jobId: string): Promise<MeteorologicalJobRecord> {
  return requestJson(
    `/api/v1/meteorology/jobs/${encodeURIComponent(jobId)}`,
    undefined,
    30_000,
    meteorologicalJobRecordSchema,
  )
}

export async function importManagedLayer(
  file: File,
  options?: {
    name?: string
    description?: string
    category?: string
    tags?: string[]
    status?: string
    analysisCapabilities?: string[]
    sourceConfigSummary?: string
  },
): Promise<LayerDescriptor> {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.name) formData.append('name', options.name)
  if (options?.description) formData.append('description', options.description)
  if (options?.category) formData.append('category', options.category)
  if (options?.tags?.length) formData.append('tags', options.tags.join(','))
  if (options?.status) formData.append('status', options.status)
  if (options?.analysisCapabilities?.length) {
    formData.append('analysisCapabilities', options.analysisCapabilities.join(','))
  }
  if (options?.sourceConfigSummary) formData.append('sourceConfigSummary', options.sourceConfigSummary)
  return requestFormJson('/api/v1/layers/import', formData, '后台图层导入请求失败', 120_000, layerDescriptorSchema)
}

export async function replaceManagedLayer(layerKey: string, file: File): Promise<LayerDescriptor> {
  const formData = new FormData()
  formData.append('file', file)
  return requestFormJson(
    `/api/v1/layers/${encodeURIComponent(layerKey)}/replace`,
    formData,
    '图层数据替换请求失败',
    120_000,
    layerDescriptorSchema,
  )
}

export function listAllFiles(threadId?: string | null): Promise<FileListResponse> {
  return requestControl('file:list', { threadId }, fileListResponseSchema)
}

export async function uploadAnyFile(
  file: File,
  threadId?: string | null,
  requestId?: string,
  sourceRelativePath?: string | null,
): Promise<z.infer<typeof uploadedFileSchema>> {
  const form = new FormData()
  form.append('file', file)
  if (threadId) form.append('threadId', threadId)
  if (requestId) form.append('requestId', requestId)
  if (sourceRelativePath) form.append('sourceRelativePath', sourceRelativePath)
  return requestFormJson('/api/v1/files/upload', form, '文件上传请求失败', 600_000, uploadedFileSchema)
}

export function deleteAnyFile(fileId: string, threadId?: string | null): Promise<z.infer<typeof deletedFileSchema>> {
  return requestControl('file:delete', { fileId, threadId }, deletedFileSchema)
}
