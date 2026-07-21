// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 终端录制密钥环
//
//   文件:       keyring.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'

const keyringFileSchema = z.object({
  version: z.literal(1),
  keys: z.array(z.object({
    id: z.string().min(1).max(100),
    status: z.enum(['active', 'retired']),
    keyBase64: z.string().min(1),
  }).strict()).min(1),
}).strict()

export interface WrappedTerminalDataKey {
  keyId: string
  wrappedDataKey: string
  keyWrapNonce: string
  keyWrapAuthTag: string
}

export class TerminalKeyring {
  private constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  static async load(filePath: string, activeKeyId: string): Promise<TerminalKeyring> {
    let raw: string
    try {
      if (process.platform !== 'win32') {
        const metadata = await stat(filePath)
        if ((metadata.mode & 0o077) !== 0) throw new Error('insecure permissions')
      }
      raw = await readFile(filePath, 'utf8')
    } catch {
      throw new Error('终端录制主密钥文件不可读取，Ops Gateway 已拒绝启动。')
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      throw new Error('终端录制主密钥文件不是有效 JSON，Ops Gateway 已拒绝启动。')
    }
    const parsed = keyringFileSchema.safeParse(value)
    if (!parsed.success) throw new Error('终端录制主密钥文件格式无效，Ops Gateway 已拒绝启动。')
    const keys = new Map<string, Buffer>()
    for (const entry of parsed.data.keys) {
      if (keys.has(entry.id)) throw new Error('终端录制主密钥文件包含重复 key id。')
      const key = Buffer.from(entry.keyBase64, 'base64')
      if (key.byteLength !== 32) throw new Error('终端录制主密钥必须为 32 字节。')
      keys.set(entry.id, key)
    }
    const activeEntry = parsed.data.keys.find(entry => entry.id === activeKeyId)
    if (!activeEntry || activeEntry.status !== 'active') {
      throw new Error('终端录制活动主密钥未配置或状态不是 active。')
    }
    return new TerminalKeyring(keys, activeKeyId)
  }

  createSessionDataKey(terminalId: string): { dataKey: Buffer; wrapped: WrappedTerminalDataKey } {
    const dataKey = randomBytes(32)
    return { dataKey, wrapped: this.wrap(terminalId, dataKey, this.activeKeyId) }
  }

  unwrap(terminalId: string, wrapped: WrappedTerminalDataKey): Buffer {
    const key = this.keys.get(wrapped.keyId)
    if (!key) throw new Error('终端录制所需主密钥不存在。')
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.keyWrapNonce, 'base64'))
      decipher.setAAD(keyAad(terminalId))
      decipher.setAuthTag(Buffer.from(wrapped.keyWrapAuthTag, 'base64'))
      const dataKey = Buffer.concat([
        decipher.update(Buffer.from(wrapped.wrappedDataKey, 'base64')),
        decipher.final(),
      ])
      if (dataKey.byteLength !== 32) throw new Error('invalid data key length')
      return dataKey
    } catch {
      throw new Error('终端录制数据密钥认证失败。')
    }
  }

  rewrap(terminalId: string, wrapped: WrappedTerminalDataKey): WrappedTerminalDataKey {
    const dataKey = this.unwrap(terminalId, wrapped)
    try {
      return this.wrap(terminalId, dataKey, this.activeKeyId)
    } finally {
      dataKey.fill(0)
    }
  }

  private wrap(terminalId: string, dataKey: Buffer, keyId: string): WrappedTerminalDataKey {
    const key = this.keys.get(keyId)
    if (!key) throw new Error('活动主密钥不存在。')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(keyAad(terminalId))
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
    return {
      keyId,
      wrappedDataKey: ciphertext.toString('base64'),
      keyWrapNonce: nonce.toString('base64'),
      keyWrapAuthTag: cipher.getAuthTag().toString('base64'),
    }
  }
}

function keyAad(terminalId: string): Buffer {
  return Buffer.from(`geoforge:terminal-key:${terminalId}`, 'utf8')
}
