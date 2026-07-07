// +-------------------------------------------------------------------------
//
//   地理智能平台 - JSONL Journal + Recovery
//
//   文件:       journal.ts
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

// Journal 写入在 durable append 之前，提供崩溃恢复依据。
// 启动时回放 journal：可读行继续加载，损坏行写入 corruption.jsonl。
// 不静默兼容旧 runtime——需要 STORE_SCHEMA_VERSION 匹配。

import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { nowUtc } from '../utils/ids.js'
import { logger } from '../observability/logger.js'
import { jsonlCorruptionTotal } from '../observability/metrics.js'

const JOURNAL_SCHEMA_VERSION = 3

export interface JournalEntry {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  operationId: string
  kind: 'append_transcript' | 'append_item' | 'append_event' | 'write_checkpoint' | 'update_manifest'
  threadId: string
  runId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface RecoveryReport {
  journalPath: string
  totalEntries: number
  recoveredEntries: number
  corruptedEntries: number
  skippedDuplicateEntries: number
  errors: string[]
}

// 写入 journal entry 到线程的 journal.jsonl 文件。
// 调用方必须在 durable append 之前先写 journal。
export async function appendJournalEntry(
  rootDir: string,
  threadId: string,
  entry: Omit<JournalEntry, 'schemaVersion' | 'createdAt'>,
): Promise<void> {
  const dir = path.join(rootDir, threadId)
  await mkdir(dir, { recursive: true })
  const journalPath = path.join(dir, 'journal.jsonl')

  const record: JournalEntry = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    createdAt: nowUtc(),
    ...entry,
  }

  const handle = await open(journalPath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// 启动时回放 journal，返回可恢复的 entry 列表。
// 损坏行单独写入 corruption.jsonl 并记录指标。
export async function recoverJournal(
  rootDir: string,
  threadId: string,
  threadName: string,
): Promise<RecoveryReport> {
  const journalPath = path.join(rootDir, threadId, 'journal.jsonl')
  const report: RecoveryReport = {
    journalPath,
    totalEntries: 0,
    recoveredEntries: 0,
    corruptedEntries: 0,
    skippedDuplicateEntries: 0,
    errors: [],
  }

  let raw: string
  try {
    raw = await readFile(journalPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
    report.errors.push(`无法读取 journal: ${String(error)}`)
    return report
  }

  const lines = raw.split('\n').filter(Boolean)
  const seen = new Set<string>()
  const recovered: JournalEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    report.totalEntries++
    try {
      const parsed: unknown = JSON.parse(lines[i])
      if (!isJournalEntry(parsed)) {
        throw new Error(`schema version 不匹配或缺少必需字段`)
      }
      const key = parsed.operationId
      if (seen.has(key)) {
        report.skippedDuplicateEntries++
        continue
      }
      seen.add(key)
      recovered.push(parsed)
      report.recoveredEntries++
    } catch {
      report.corruptedEntries++
      jsonlCorruptionTotal.inc({ scope: threadName })
      await appendCorruptionRecord(rootDir, threadId, i + 1, lines[i])
    }
  }

  logger.info({ threadId, recovered: report.recoveredEntries, corrupted: report.corruptedEntries }, '[journal] recovery complete')
  return report
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === JOURNAL_SCHEMA_VERSION
    && typeof record.operationId === 'string'
    && typeof record.kind === 'string'
    && typeof record.threadId === 'string'
    && typeof record.createdAt === 'string'
}

async function appendCorruptionRecord(
  rootDir: string,
  threadId: string,
  lineNumber: number,
  rawLine: string,
): Promise<void> {
  const dir = path.join(rootDir, threadId)
  const corruptionPath = path.join(dir, 'corruption.jsonl')
  const record = {
    threadId,
    lineNumber,
    rawLine: rawLine.slice(0, 1024),
    detectedAt: nowUtc(),
  }

  await mkdir(dir, { recursive: true })
  const handle = await open(corruptionPath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
