// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆 API
//
//   文件:       memoryApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  memoryFileRecordSchema,
  threadMemoryDocumentSchema,
  type MemoryFileRecord,
  type MemorySearchResult,
  type ThreadMemoryDocument,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import { memoryListResponseSchema, memorySearchResponseSchema } from './responseSchemas'
import { requestControl } from './transport'

export type EditableMemoryScope = 'private' | 'team'

export interface WriteMemoryPayload {
  scope: EditableMemoryScope
  type: 'user' | 'feedback' | 'project' | 'reference'
  name: string
  description: string
  content: string
  relativePath?: string | null
}

const deletedMemorySchema = z.object({ deleted: z.boolean(), relativePath: z.string() })
const dreamMemoryResponseSchema = z.object({
  changed: z.boolean(),
  message: z.string(),
  records: z.array(memoryFileRecordSchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
})
const instructionMemoryResponseSchema = z.object({
  enabled: z.boolean(),
  entrypointName: z.string(),
  records: z.array(memoryFileRecordSchema),
})

export function listMemories(scope?: EditableMemoryScope): Promise<{ records: MemoryFileRecord[]; total: number }> {
  return requestControl('memory:list', { scope }, memoryListResponseSchema)
}

export function readMemory(scope: EditableMemoryScope, relativePath: string): Promise<MemoryFileRecord> {
  return requestControl('memory:read', { scope, relativePath }, memoryFileRecordSchema)
}

export function writeMemory(payload: WriteMemoryPayload): Promise<MemoryFileRecord> {
  return requestControl('memory:write', { ...payload }, memoryFileRecordSchema)
}

export function deleteMemory(scope: EditableMemoryScope, relativePath: string): Promise<z.infer<typeof deletedMemorySchema>> {
  return requestControl('memory:delete', { scope, relativePath }, deletedMemorySchema)
}

export function searchMemories(query: string): Promise<{ matches: MemorySearchResult[]; total: number }> {
  return requestControl('memory:search', { query }, memorySearchResponseSchema)
}

export function extractMemories(threadId: string, runId?: string | null): Promise<{ records: MemoryFileRecord[]; total: number }> {
  return requestControl('memory:extract', { threadId, runId }, memoryListResponseSchema)
}

export function dreamMemories(force = false): Promise<z.infer<typeof dreamMemoryResponseSchema>> {
  return requestControl('memory:dream', { force }, dreamMemoryResponseSchema)
}

export function getSessionMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('memory:session:get', { threadId }, threadMemoryDocumentSchema)
}

export function rebuildSessionMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('memory:session:rebuild', { threadId }, threadMemoryDocumentSchema)
}

export function listInstructionMemories(): Promise<z.infer<typeof instructionMemoryResponseSchema>> {
  return requestControl('memory:instructions:list', {}, instructionMemoryResponseSchema)
}
