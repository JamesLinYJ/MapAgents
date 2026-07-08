// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程记忆文件存储
//
//   文件:       threadMemoryFileStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { threadMemoryDocumentSchema, type ThreadManifest, type ThreadMemoryDocument, type AgentThreadRecord } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'
import { appendJsonLineDurable, atomicWriteJson, atomicWriteText, estimateTokens } from './fileConversationIo.js'
import type { DurableJsonlStore } from './durableJsonlStore.js'

export interface ThreadMemoryFile {
  thread: AgentThreadRecord
  manifest: ThreadManifest
}

// ThreadMemoryFileStore 只处理 memory/versions.jsonl、current.md 和 thread manifest 投影。
// 调用方提供 thread 文件快照，避免本类接管线程定位和生命周期。
export class ThreadMemoryFileStore {
  constructor(private readonly jsonlStore: DurableJsonlStore) {}

  async get(threadId: string, directory: string): Promise<ThreadMemoryDocument> {
    const versions = await this.jsonlStore.read(
      path.join(directory, 'memory', 'versions.jsonl'),
      threadId,
      threadMemoryDocumentSchemaLike,
    )
    return versions.at(-1) ?? {
      threadId,
      version: 0,
      content: '',
      generatedContent: '',
      pinnedContent: '',
      source: 'system',
      basedOnEntryId: null,
      estimatedTokens: 0,
      updatedAt: nowUtc(),
    }
  }

  async save(args: {
    threadId: string
    directory: string
    input: Pick<ThreadMemoryDocument, 'content' | 'generatedContent' | 'pinnedContent' | 'source' | 'basedOnEntryId'>
    expectedVersion?: number
    threadFile: ThreadMemoryFile
  }): Promise<ThreadMemoryDocument> {
    const current = await this.get(args.threadId, args.directory)
    if (args.expectedVersion !== undefined && current.version !== args.expectedVersion) {
      throw new Error(`memory 版本冲突：期望 ${args.expectedVersion}，当前 ${current.version}`)
    }
    const document: ThreadMemoryDocument = {
      threadId: args.threadId,
      version: current.version + 1,
      content: args.input.content,
      generatedContent: args.input.generatedContent,
      pinnedContent: args.input.pinnedContent,
      source: args.input.source,
      basedOnEntryId: args.input.basedOnEntryId,
      estimatedTokens: estimateTokens(args.input.content),
      updatedAt: nowUtc(),
    }
    const memoryDir = path.join(args.directory, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await appendJsonLineDurable(path.join(memoryDir, 'versions.jsonl'), document)
    await atomicWriteText(path.join(memoryDir, 'current.md'), document.content)
    args.threadFile.manifest.memoryVersion = document.version
    args.threadFile.manifest.memoryBasedOnTokens = args.threadFile.manifest.estimatedContextTokens
    args.threadFile.manifest.updatedAt = document.updatedAt
    await atomicWriteJson(path.join(args.directory, 'thread.json'), args.threadFile)
    return document
  }
}

const threadMemoryDocumentSchemaLike = {
  parse(value: unknown): ThreadMemoryDocument {
    return threadMemoryDocumentSchema.parse(value)
  },
}
