// +-------------------------------------------------------------------------
//
//   地理智能平台 - Durable JSONL 存储队列
//
//   文件:       durableJsonlStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { errorLogPayload, logger } from '../observability/logger.js'
import { appendJsonLineDurable, recordJsonLineCorruption } from './fileConversationIo.js'

// DurableJsonlStore 是 JSONL append/read/flush 的唯一拥有者。
// FileConversationStore 负责资源编排；本类负责按文件串行追加、行级恢复和损坏行登记。
export class DurableJsonlStore {
  private readonly writeQueues = new Map<string, Promise<void>>()

  append(filePath: string, record: unknown): Promise<void> {
    const previous = this.writeQueues.get(filePath)?.catch(error => {
      logger.error({ error: errorLogPayload(error), filePath }, 'previous append failed')
    }) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await appendJsonLineDurable(filePath, record)
    })
    this.writeQueues.set(filePath, next)
    const tracked = next.catch(error => {
      logger.error({ error: errorLogPayload(error), filePath }, 'append failed')
      throw error
    }).finally(() => {
      if (this.writeQueues.get(filePath) === next) this.writeQueues.delete(filePath)
    })
    return tracked
  }

  async read<T>(
    filePath: string,
    threadId: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n')
    const records: T[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        records.push(schema.parse(JSON.parse(line)))
      } catch (error) {
        const isFinalPartialLine = index === lines.length - 1 && !text.endsWith('\n')
        if (isFinalPartialLine) break
        await recordJsonLineCorruption(filePath, threadId, index + 1, error)
      }
    }
    return records
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writeQueues.values()])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, `JSONL 写入队列 flush 失败：${failures.length} 个写入队列未完成`)
    }
  }
}
