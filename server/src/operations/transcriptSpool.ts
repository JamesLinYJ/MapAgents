// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Broker 密文离线 spool
//
//   文件:       transcriptSpool.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { brokerTranscriptChunkSchema, type BrokerTranscriptChunk } from './brokerProtocol.js'

export class TranscriptSpool {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await this.list(1)
  }

  async put(chunk: BrokerTranscriptChunk): Promise<void> {
    const parsed = brokerTranscriptChunkSchema.parse(chunk)
    const target = this.pathFor(parsed.chunkId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, JSON.stringify(parsed), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  }

  async list(limit = 100): Promise<BrokerTranscriptChunk[]> {
    const names = (await readdir(this.root)).filter(name => name.endsWith('.chunk.json')).sort()
    const result: BrokerTranscriptChunk[] = []
    for (const name of names.slice(0, Math.max(1, Math.min(500, Math.trunc(limit))))) {
      const raw = await readFile(path.join(this.root, name), 'utf8')
      const parsed = brokerTranscriptChunkSchema.safeParse(JSON.parse(raw) as unknown)
      if (!parsed.success) throw new Error('Terminal Broker spool 包含损坏的密文分块，Broker 已拒绝继续运行。')
      result.push(parsed.data)
    }
    return result
  }

  async acknowledge(chunkId: string): Promise<void> {
    await rm(this.pathFor(chunkId), { force: true })
  }

  private pathFor(chunkId: string): string {
    if (!/^[A-Za-z0-9_.-]{1,180}$/u.test(chunkId)) throw new Error('录制分块标识无效。')
    return path.join(this.root, `${chunkId}.chunk.json`)
  }
}
