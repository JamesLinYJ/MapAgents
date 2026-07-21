// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 终端增量录制加密格式
//
//   文件:       terminalRecording.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

const MAGIC = Buffer.from('GFTR1\n', 'ascii')
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

export const asciicastEventSchema = z.tuple([
  z.number().nonnegative(),
  z.enum(['o', 'r']),
  z.string(),
])

export type AsciicastEvent = z.infer<typeof asciicastEventSchema>

export interface EncryptedTranscriptChunk {
  sequence: number
  encrypted: Buffer
  eventCount: number
  firstEventMilliseconds: number
  lastEventMilliseconds: number
}

export function encryptTranscriptChunk(input: {
  terminalId: string
  sequence: number
  dataKey: Uint8Array
  events: AsciicastEvent[]
}): EncryptedTranscriptChunk {
  if (input.dataKey.byteLength !== 32) throw new Error('终端会话数据密钥长度无效。')
  if (!input.events.length) throw new Error('不能写入空终端录制分块。')
  const normalized = input.events.map(event => asciicastEventSchema.parse(event))
  const plaintext = Buffer.from(`${normalized.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(input.dataKey), nonce)
  cipher.setAAD(chunkAad(input.terminalId, input.sequence))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const encrypted = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext])
  return {
    sequence: input.sequence,
    encrypted,
    eventCount: normalized.length,
    firstEventMilliseconds: Math.round((normalized[0]?.[0] ?? 0) * 1_000),
    lastEventMilliseconds: Math.round((normalized.at(-1)?.[0] ?? 0) * 1_000),
  }
}

export function decryptTranscriptChunk(input: {
  terminalId: string
  sequence: number
  dataKey: Uint8Array
  encrypted: Uint8Array
}): AsciicastEvent[] {
  if (input.dataKey.byteLength !== 32) throw new Error('终端会话数据密钥长度无效。')
  const bytes = Buffer.from(input.encrypted)
  const minimum = MAGIC.byteLength + NONCE_BYTES + AUTH_TAG_BYTES + 1
  if (bytes.byteLength < minimum || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error('终端录制分块格式无效。')
  }
  const nonceStart = MAGIC.byteLength
  const tagStart = nonceStart + NONCE_BYTES
  const ciphertextStart = tagStart + AUTH_TAG_BYTES
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(input.dataKey),
      bytes.subarray(nonceStart, tagStart),
    )
    decipher.setAAD(chunkAad(input.terminalId, input.sequence))
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]).toString('utf8')
    return plaintext.split('\n').filter(Boolean).map(line => asciicastEventSchema.parse(JSON.parse(line) as unknown))
  } catch {
    throw new Error('终端录制分块认证失败。')
  }
}

export function encodeAsciicastV2(input: {
  width: number
  height: number
  timestamp: number
  shell: string
  events: AsciicastEvent[]
}): string {
  const header = {
    version: 2,
    width: input.width,
    height: input.height,
    timestamp: input.timestamp,
    env: { SHELL: input.shell, TERM: 'xterm-256color' },
  }
  const eventLines = input.events.map(event => JSON.stringify(asciicastEventSchema.parse(event)))
  return `${JSON.stringify(header)}\n${eventLines.join('\n')}${eventLines.length ? '\n' : ''}`
}

function chunkAad(terminalId: string, sequence: number): Buffer {
  return Buffer.from(`geoforge:terminal-chunk:${terminalId}:${sequence}`, 'utf8')
}
