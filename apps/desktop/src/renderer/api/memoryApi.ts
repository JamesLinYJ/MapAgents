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
  type MemoryFileRecord,
  type MemorySearchResult,
  type ThreadMemoryDocument,
  type WsCommandResponse,
} from '@geo-agent-platform/shared-types'

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

export function listMemories(scope?: EditableMemoryScope): Promise<{ records: MemoryFileRecord[]; total: number }> {
  return requestControl('memory:list', { scope })
}

export function readMemory(scope: EditableMemoryScope, relativePath: string): Promise<MemoryFileRecord> {
  return requestControl('memory:read', { scope, relativePath })
}

export function writeMemory(payload: WriteMemoryPayload): Promise<MemoryFileRecord> {
  return requestControl('memory:write', { ...payload })
}

export function deleteMemory(
  scope: EditableMemoryScope,
  relativePath: string,
): Promise<WsCommandResponse<'memory:delete'>> {
  return requestControl('memory:delete', { scope, relativePath })
}

export function searchMemories(query: string): Promise<{ matches: MemorySearchResult[]; total: number }> {
  return requestControl('memory:search', { query })
}

export function extractMemories(threadId: string, runId?: string | null): Promise<{ records: MemoryFileRecord[]; total: number }> {
  return requestControl('memory:extract', { threadId, runId })
}

export function dreamMemories(force = false): Promise<WsCommandResponse<'memory:dream'>> {
  return requestControl('memory:dream', { force })
}

export function getSessionMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('memory:session:get', { threadId })
}

export function rebuildSessionMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('memory:session:rebuild', { threadId })
}

export function listInstructionMemories(): Promise<WsCommandResponse<'memory:instructions:list'>> {
  return requestControl('memory:instructions:list')
}
