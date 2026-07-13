// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内容寻址对象存储
//
//   文件:       contentAddressedObjectStore.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ContentRef } from '../schemas/types.js'

// ContentAddressedObjectStore 只负责 SHA256 blob 的物理读写和完整性校验。
// 引用生命周期、GC 和会话语义由 FileConversationStore 编排。
export class ContentAddressedObjectStore {
  constructor(private readonly objectsRoot: string) {}

  async put(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relativePath = path.posix.join('objects', 'sha256', hash.slice(0, 2), hash)
    const target = path.join(this.objectsRoot, hash.slice(0, 2), hash)
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await writeFile(target, bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return { algorithm: 'sha256', hash, mediaType, sizeBytes: bytes.byteLength, relativePath }
  }

  async read(reference: ContentRef): Promise<Uint8Array> {
    if (reference.algorithm !== 'sha256') {
      throw new Error('contentRef 哈希格式无效')
    }
    return this.readByHash(reference.hash)
  }

  async readByHash(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('contentRef 哈希格式无效')
    const target = path.join(this.objectsRoot, hash.slice(0, 2), hash)
    const bytes = await readFile(target)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== hash) throw new Error(`contentRef 校验失败：${hash}`)
    return bytes
  }
}
