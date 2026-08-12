// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运维监督运行时路径测试
//
//   文件:       paths.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
} from './paths.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('operations IPC endpoint', () => {
  it('always uses the per-user XDG runtime directory instead of the data directory', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-long-root-'))
    cleanupPaths.push(directory)
    const projectRoot = path.join(directory, '长路径'.repeat(24))
    await mkdir(projectRoot, { recursive: true })

    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })

    expect(Buffer.byteLength(paths.endpoint, 'utf8')).toBeLessThanOrEqual(100)
    expect(paths.endpoint).not.toContain(projectRoot)
    if (process.env.XDG_RUNTIME_DIR?.trim()) {
      expect(paths.endpoint).toContain(path.resolve(process.env.XDG_RUNTIME_DIR))
    }
    expect(paths.operationsRoot).toContain(projectRoot)
  })
})

describe('operations secret files', () => {
  it('can protect an existing development secret repeatedly without rotating it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-secret-'))
    cleanupPaths.push(directory)
    const filePath = path.join(directory, 'supervisor.token')

    const created = await ensureSecretFile(filePath, true)
    const reopened = await ensureSecretFile(filePath, true)

    expect(reopened).toBe(created)
    await expect(assertProductionSecretPermissions(filePath)).resolves.toBeUndefined()
  }, process.platform === 'win32' ? 15_000 : 5_000)
})
