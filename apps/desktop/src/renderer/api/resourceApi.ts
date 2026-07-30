// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件、图层、Artifact 与气象数据 API
//
//   文件:       resourceApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
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

import type { DesktopFileSelectionHandle } from '../../contracts/desktopIpc'
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
  file: DesktopFileSelectionHandle,
  threadId?: string | null,
  sourceRelativePath?: string | null,
): Promise<LayerDescriptor> {
  return requestFormJson(
    '/api/v1/layers/register',
    uploadBody(file, [
      { name: 'session_id', value: sessionId },
      ...(threadId ? [{ name: 'threadId', value: threadId }] : []),
      ...(sourceRelativePath ? [{ name: 'sourceRelativePath', value: sourceRelativePath }] : []),
    ]),
    '图层上传请求失败',
    120_000,
    layerDescriptorSchema,
  )
}

export async function uploadMeteorologicalDataset(
  sessionId: string,
  file: DesktopFileSelectionHandle,
  threadId: string,
  sourceRelativePath?: string | null,
): Promise<{ dataset: MeteorologicalDatasetRecord; job: MeteorologicalJobRecord | null }> {
  return requestFormJson(
    '/api/v1/meteorology/datasets',
    uploadBody(file, [
      { name: 'sessionId', value: sessionId },
      { name: 'threadId', value: threadId },
      ...(sourceRelativePath ? [{ name: 'sourceRelativePath', value: sourceRelativePath }] : []),
    ]),
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
  file: DesktopFileSelectionHandle,
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
  const fields = [
    ...(options?.name ? [{ name: 'name', value: options.name }] : []),
    ...(options?.description ? [{ name: 'description', value: options.description }] : []),
    ...(options?.category ? [{ name: 'category', value: options.category }] : []),
    ...(options?.tags?.length ? [{ name: 'tags', value: options.tags.join(',') }] : []),
    ...(options?.status ? [{ name: 'status', value: options.status }] : []),
    ...(options?.analysisCapabilities?.length
      ? [{ name: 'analysisCapabilities', value: options.analysisCapabilities.join(',') }]
      : []),
    ...(options?.sourceConfigSummary
      ? [{ name: 'sourceConfigSummary', value: options.sourceConfigSummary }]
      : []),
  ]
  return requestFormJson(
    '/api/v1/layers/import',
    uploadBody(file, fields),
    '后台图层导入请求失败',
    120_000,
    layerDescriptorSchema,
  )
}

export async function replaceManagedLayer(
  layerKey: string,
  file: DesktopFileSelectionHandle,
): Promise<LayerDescriptor> {
  return requestFormJson(
    `/api/v1/layers/${encodeURIComponent(layerKey)}/replace`,
    uploadBody(file),
    '图层数据替换请求失败',
    120_000,
    layerDescriptorSchema,
  )
}

export function listAllFiles(threadId: string): Promise<FileListResponse> {
  return requestControl('file:list', { threadId }, fileListResponseSchema)
}

export async function uploadAnyFile(
  file: DesktopFileSelectionHandle,
  threadId: string,
  requestId?: string,
  sourceRelativePath?: string | null,
): Promise<z.infer<typeof uploadedFileSchema>> {
  return requestFormJson(
    '/api/v1/files/upload',
    uploadBody(file, [
      { name: 'threadId', value: threadId },
      ...(requestId ? [{ name: 'requestId', value: requestId }] : []),
      ...(sourceRelativePath ? [{ name: 'sourceRelativePath', value: sourceRelativePath }] : []),
    ]),
    '文件上传请求失败',
    600_000,
    uploadedFileSchema,
  )
}

export function deleteAnyFile(fileId: string, threadId: string): Promise<z.infer<typeof deletedFileSchema>> {
  return requestControl('file:delete', { fileId, threadId }, deletedFileSchema)
}

function uploadBody(
  file: DesktopFileSelectionHandle,
  fields: Array<{ name: string; value: string }> = [],
) {
  return {
    fields,
    files: [{ fieldName: 'file', file }],
  }
}
