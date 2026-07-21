// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 终端录制加密与密钥轮换测试
//
//   文件:       terminalEncryption.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { TerminalKeyring } from './keyring.js'
import { decryptTranscriptChunk, encryptTranscriptChunk } from './terminalRecording.js'
import { TranscriptSpool } from './transcriptSpool.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('AES-256-GCM 录制分块', () => {
  it('密盘不含明文，并绑定会话和序号防篡改', () => {
    const dataKey = randomBytes(32)
    const plaintext = '绝不能出现在磁盘中的中文命令输出'
    const chunk = encryptTranscriptChunk({
      terminalId: 'terminal_a',
      sequence: 7,
      dataKey,
      events: [[0.125, 'o', plaintext], [0.25, 'r', '120x32']],
    })
    expect(chunk.encrypted.includes(Buffer.from(plaintext, 'utf8'))).toBe(false)
    expect(decryptTranscriptChunk({ terminalId: 'terminal_a', sequence: 7, dataKey, encrypted: chunk.encrypted }))
      .toEqual([[0.125, 'o', plaintext], [0.25, 'r', '120x32']])

    const tampered = Buffer.from(chunk.encrypted)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    expect(() => decryptTranscriptChunk({ terminalId: 'terminal_a', sequence: 7, dataKey, encrypted: tampered }))
      .toThrow('认证失败')
    expect(() => decryptTranscriptChunk({ terminalId: 'terminal_b', sequence: 7, dataKey, encrypted: chunk.encrypted }))
      .toThrow('认证失败')
    expect(() => decryptTranscriptChunk({ terminalId: 'terminal_a', sequence: 8, dataKey, encrypted: chunk.encrypted }))
      .toThrow('认证失败')
  })
})

describe('会话数据密钥包装与轮换', () => {
  it('旧主密钥可解包，重包装后只依赖新活动密钥', async () => {
    const directory = await createTemporaryDirectory()
    const oldKey = randomBytes(32).toString('base64')
    const newKey = randomBytes(32).toString('base64')
    const oldFile = path.join(directory, 'old.json')
    const rotatingFile = path.join(directory, 'rotating.json')
    const newOnlyFile = path.join(directory, 'new.json')
    await writeKeyring(oldFile, [{ id: 'old', status: 'active', keyBase64: oldKey }])
    await writeKeyring(rotatingFile, [
      { id: 'old', status: 'retired', keyBase64: oldKey },
      { id: 'new', status: 'active', keyBase64: newKey },
    ])
    await writeKeyring(newOnlyFile, [{ id: 'new', status: 'active', keyBase64: newKey }])

    const oldRing = await TerminalKeyring.load(oldFile, 'old')
    const created = oldRing.createSessionDataKey('terminal_rotate')
    const expected = Buffer.from(created.dataKey)
    const rotatingRing = await TerminalKeyring.load(rotatingFile, 'new')
    const rewrapped = rotatingRing.rewrap('terminal_rotate', created.wrapped)
    expect(rewrapped.keyId).toBe('new')
    const newRing = await TerminalKeyring.load(newOnlyFile, 'new')
    expect(newRing.unwrap('terminal_rotate', rewrapped)).toEqual(expected)
    expect(() => newRing.unwrap('terminal_rotate', created.wrapped)).toThrow('主密钥不存在')
    created.dataKey.fill(0)
    expected.fill(0)
  })
})

describe('Broker 离线 spool', () => {
  it('只落盘密文且使用 Windows 安全文件名', async () => {
    const directory = await createTemporaryDirectory()
    const spool = new TranscriptSpool(directory)
    await spool.initialize()
    const plaintext = '绝不能落盘的明文'
    const encryptedChunk = encryptTranscriptChunk({
      terminalId: 'terminal_abc',
      sequence: 0,
      dataKey: randomBytes(32),
      events: [[0, 'o', plaintext]],
    })
    const encrypted = encryptedChunk.encrypted.toString('base64')
    await spool.put({
      chunkId: 'terminal_abc.0000000000',
      terminalId: 'terminal_abc',
      sequence: 0,
      encryptedBase64: encrypted,
      sizeBytes: encryptedChunk.encrypted.byteLength,
      eventCount: 1,
      firstEventMilliseconds: 0,
      lastEventMilliseconds: 0,
      createdAt: new Date().toISOString(),
    })
    const files = await import('node:fs/promises').then(module => module.readdir(directory))
    expect(files).toEqual(['terminal_abc.0000000000.chunk.json'])
    const persisted = await readFile(path.join(directory, files[0] ?? ''), 'utf8')
    expect(persisted).not.toContain(plaintext)
    expect((await spool.list())[0]?.encryptedBase64).toBe(encrypted)
    await expect(spool.acknowledge('terminal_abc:0000000000')).rejects.toThrow('标识无效')
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-ops-encryption-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeKeyring(
  filePath: string,
  keys: Array<{ id: string; status: 'active' | 'retired'; keyBase64: string }>,
): Promise<void> {
  await writeFile(filePath, JSON.stringify({ version: 1, keys }), { encoding: 'utf8', mode: 0o600 })
}
