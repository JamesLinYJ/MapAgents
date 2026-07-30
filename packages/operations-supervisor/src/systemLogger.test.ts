// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Supervisor 轮转日志测试
//
//   文件:       systemLogger.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveOperationsPaths } from './paths.js'
import { createSupervisorLogger } from './systemLogger.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('createSupervisorLogger', () => {
  it('writes structured JSONL and redacts secret-bearing fields', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geoforge-system-log-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const output = createSupervisorLogger(paths, 'debug', { includeStdout: false })

    output.logger.info({
      serviceId: 'api',
      password: 'do-not-store-this',
      nested: { token: 'also-secret' },
    }, 'API 监督事件')
    await output.close()

    const files = await readdir(paths.operationsRoot)
    const activeLog = files.find(file => (
      file.startsWith(`supervisor-${paths.workspaceId}.`)
      && file.endsWith('.jsonl')
    ))
    expect(activeLog).toBeTruthy()
    const lines = (await readFile(path.join(paths.operationsRoot, activeLog ?? ''), 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(entry).toMatchObject({
      component: 'supervisor',
      serviceId: 'api',
      password: '[REDACTED]',
      msg: 'API 监督事件',
    })
    expect(entry).not.toHaveProperty('nested.token', 'also-secret')
    expect(JSON.stringify(entry)).not.toContain('do-not-store-this')
    expect(JSON.stringify(entry)).not.toContain('also-secret')
  })
})
