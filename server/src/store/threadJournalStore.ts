// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程 Journal 恢复存储
//
//   文件:       threadJournalStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  threadManifestSchema,
  transcriptEntrySchema,
  type AgentThreadRecord,
  type ThreadManifest,
} from '../schemas/types.js'
import { appendJsonLineDurable, atomicWriteJson, jsonLinesContainId, listFileNames, readRawJson, safeId } from './fileConversationIo.js'

const STORE_SCHEMA_VERSION = 2

export interface ThreadJournalFile {
  thread: AgentThreadRecord
  manifest: ThreadManifest
}

const threadJournalSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  operationId: z.string(),
  type: z.literal('appendTranscript'),
  entry: transcriptEntrySchema,
  threadFile: z.object({
    thread: z.custom<AgentThreadRecord>(value => typeof value === 'object' && value !== null),
    manifest: threadManifestSchema,
  }),
  supervisorTranscriptPath: z.string().nullable(),
  createdAt: z.string(),
})

export type ThreadJournal = z.infer<typeof threadJournalSchema>

// ThreadJournalStore 管理 appendTranscript 的 journal → durable append → manifest commit。
// 调用方只提供已计算好的 entry 和 threadFile，不在这里决定 transcript 语义。
export class ThreadJournalStore {
  async writeAndApply(directory: string, journal: ThreadJournal): Promise<void> {
    const journalPath = await this.write(directory, journal)
    await this.apply(directory, journal, journalPath)
  }

  async recover(directory: string): Promise<void> {
    const journalDirectory = path.join(directory, 'journals')
    for (const fileName of await listFileNames(journalDirectory)) {
      if (!fileName.endsWith('.json')) continue
      const journalPath = path.join(journalDirectory, fileName)
      const raw = await readRawJson(journalPath)
      if (!raw) {
        await rm(journalPath, { force: true })
        continue
      }
      const parsed = threadJournalSchema.parse(raw)
      await this.apply(directory, parsed, journalPath)
    }
  }

  private async write(directory: string, journal: ThreadJournal): Promise<string> {
    const journalDirectory = path.join(directory, 'journals')
    await mkdir(journalDirectory, { recursive: true })
    const journalPath = path.join(journalDirectory, `${safeId(journal.operationId, 'journalId')}.json`)
    await atomicWriteJson(journalPath, journal)
    return journalPath
  }

  private async apply(directory: string, journal: ThreadJournal, journalPath?: string): Promise<void> {
    if (journal.type !== 'appendTranscript') return
    const transcriptPath = path.join(directory, 'transcript.jsonl')
    if (!await jsonLinesContainId(transcriptPath, 'entryId', journal.entry.entryId)) {
      await appendJsonLineDurable(transcriptPath, journal.entry)
    }
    if (journal.supervisorTranscriptPath && !await jsonLinesContainId(journal.supervisorTranscriptPath, 'entryId', journal.entry.entryId)) {
      await appendJsonLineDurable(journal.supervisorTranscriptPath, journal.entry)
    }
    await atomicWriteJson(path.join(directory, 'thread.json'), journal.threadFile)
    if (journalPath) await rm(journalPath, { force: true })
  }
}
