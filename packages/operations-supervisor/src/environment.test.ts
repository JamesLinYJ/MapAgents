// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 受监督环境隔离测试
//
//   文件:       environment.test.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { environmentForConcurrently, environmentForService, secretValues } from './environment.js'

describe('service environment isolation', () => {
  it('never passes supervisor or local-root secrets to child services', () => {
    const result = environmentForService('api', {
      PATH: 'test-path',
      API_PORT: '8000',
      OPENAI_API_KEY: 'provider-secret',
      GEOFORGE_SUPERVISOR_TOKEN: 'supervisor-secret',
      GEOFORGE_LOCAL_ROOT_SECRET: 'root-secret',
      UNRELATED_SECRET: 'unrelated-secret',
    }, { GEOFORGE_ROOT: 'C:\\project' })

    expect(result).toMatchObject({ PATH: 'test-path', API_PORT: '8000', OPENAI_API_KEY: 'provider-secret' })
    expect(result).not.toHaveProperty('GEOFORGE_SUPERVISOR_TOKEN')
    expect(result).not.toHaveProperty('GEOFORGE_LOCAL_ROOT_SECRET')
    expect(result).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('collects known secret values longest-first for exact redaction', () => {
    expect(secretValues({ API_KEY: 'abcdefgh', LONG_PASSWORD: 'abcdefghijklmnop', SHORT_TOKEN: 'x' }))
      .toEqual(['abcdefghijklmnop', 'abcdefgh'])
  })

  it('masks parent-only values when concurrently merges its inherited environment', () => {
    const parent = { PATH: process.env.PATH, GEOFORGE_SUPERVISOR_TOKEN: 'must-not-leak' }
    const allowed = { PATH: process.env.PATH, API_PORT: '8000' }
    const adapterEnvironment = environmentForConcurrently(parent, allowed)
    const merged = { ...parent, ...adapterEnvironment }
    const child = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({token:process.env.GEOFORGE_SUPERVISOR_TOKEN ?? null,port:process.env.API_PORT}))',
    ], { env: merged, encoding: 'utf8' })

    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ token: null, port: '8000' })
  })
})
