// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件会话 IO 工具
//
//   文件:       fileConversationIo.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 提供文件型会话事实源需要的原子写、durable JSONL append、目录扫描和 ID 校验。
// 这些函数不持有会话状态，只处理可恢复文件 IO 的基础规则。

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
} from 'node:fs/promises'
import path from 'node:path'
import { nowUtc } from '../utils/ids.js'

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function appendJsonLineDurable(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function recordJsonLineCorruption(
  filePath: string,
  threadId: string,
  lineNumber: number,
  error: unknown,
): Promise<void> {
  await appendJsonLineDurable(path.join(path.dirname(filePath), 'corruption.jsonl'), {
    threadId,
    file: path.basename(filePath),
    lineNumber,
    reason: error instanceof Error ? error.message : String(error),
    detectedAt: nowUtc(),
  })
}

export async function jsonLinesContainId(filePath: string, key: string, expected: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && parsed[key] === expected) return true
    } catch {
      // 损坏行由标准读取路径登记；journal 恢复只负责避免重复追加已提交记录。
    }
  }
  return false
}

export async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filePath)
}

export async function readJson<T>(filePath: string, schema: { parse(value: unknown): T }): Promise<T | null> {
  const raw = await readRawJson(filePath)
  return raw === null ? null : schema.parse(raw)
}

export async function readRawJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function listDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listFileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const nested = await Promise.all(entries.map(entry => {
      const target = path.join(root, entry.name)
      return entry.isDirectory() ? listFilesRecursively(target) : Promise.resolve([target])
    }))
    return nested.flat()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function safeId(value: string, field: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed)) throw new Error(`${field} 不是合法标识符`)
  return trimmed
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.sequence !== 'number') throw new Error('invalid cursor')
    return parsed.sequence
  } catch {
    throw new Error('history cursor 无效')
  }
}

export function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
