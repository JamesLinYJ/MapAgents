// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维监督运行时路径测试
//
//   文件:       paths.test.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertProductionSecretPermissions, ensureSecretFile } from './paths.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('operations secret files', () => {
  it('can protect an existing development secret repeatedly without rotating it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-secret-'))
    cleanupPaths.push(directory)
    const filePath = path.join(directory, 'supervisor.token')

    const created = await ensureSecretFile(filePath, true)
    const reopened = await ensureSecretFile(filePath, true)

    expect(reopened).toBe(created)
    await expect(assertProductionSecretPermissions(filePath)).resolves.toBeUndefined()
  })
})
