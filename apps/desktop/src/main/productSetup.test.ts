// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面首次设置测试
//
//   文件:       productSetup.test.ts
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DesktopProductSetupService,
  parseDesktopApiBaseUrl,
} from './productSetup.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('DesktopProductSetupService', () => {
  it('turns a production package without a system manifest into first-run setup', async () => {
    const fixture = await createFixture()
    const service = fixture.service(vi.fn())

    await expect(service.status()).resolves.toEqual({
      state: 'required',
      suggestedApiBaseUrl: 'http://127.0.0.1:8000',
    })
  })

  it('tests both readiness and release compatibility before saving a non-secret user config', async () => {
    const fixture = await createFixture()
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
      if (input.endsWith('/health')) return jsonResponse({ status: 'ok' })
      return jsonResponse({
        releaseId: 'geo-agent-platform@0.1.0+test',
        apiProtocolVersion: 1,
        minDesktopProtocol: 1,
        maxDesktopProtocol: 1,
        databaseSchemaVersion: 12,
        workerContractDigest: null,
      })
    })
    const service = fixture.service(fetch, [100, 127, 200, 233])

    await expect(service.test({ apiBaseUrl: 'http://127.0.0.1:8000/' }))
      .resolves.toMatchObject({
        ok: true,
        apiBaseUrl: 'http://127.0.0.1:8000',
        latencyMs: 27,
        releaseId: 'geo-agent-platform@0.1.0+test',
        databaseSchemaVersion: 12,
      })
    await expect(service.save({ apiBaseUrl: 'http://127.0.0.1:8000/' }))
      .resolves.toEqual({
        state: 'configured',
        deploymentMode: 'remote',
        apiBaseUrl: 'http://127.0.0.1:8000',
        canReset: true,
      })

    const saved = await readFile(fixture.userSetupPath, 'utf8')
    expect(JSON.parse(saved)).toEqual({
      kind: 'geo-agent-platform.desktop-setup',
      schemaVersion: 1,
      mode: 'remote',
      apiBaseUrl: 'http://127.0.0.1:8000',
    })
    expect(saved).not.toMatch(/password|secret|api.?key/iu)
    if (process.platform !== 'win32') {
      expect((await stat(fixture.userSetupPath)).mode & 0o777).toBe(0o600)
    }
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('keeps an invalid or unavailable endpoint out of the saved product state', async () => {
    const fixture = await createFixture()
    const service = fixture.service(vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }))

    await expect(service.test({ apiBaseUrl: 'http://127.0.0.1:8123' }))
      .resolves.toMatchObject({ ok: false, message: 'connect ECONNREFUSED' })
    await expect(service.save({ apiBaseUrl: 'http://127.0.0.1:8123' }))
      .rejects.toThrow('ECONNREFUSED')
    await expect(service.status()).resolves.toMatchObject({ state: 'required' })
  })

  it('lets a user reset a remote address but never overrides an installed system runtime', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.userSetupPath, JSON.stringify({
      kind: 'geo-agent-platform.desktop-setup',
      schemaVersion: 1,
      mode: 'remote',
      apiBaseUrl: 'https://geo.example.com',
    }), { encoding: 'utf8', mode: 0o600 })
    const remote = fixture.service(vi.fn())
    await expect(remote.reset()).resolves.toMatchObject({ state: 'required' })

    const runtimeRoot = path.join(fixture.directory, 'runtime')
    const projectRoot = path.join(fixture.directory, 'project')
    const supervisorTokenFile = path.join(runtimeRoot, 'ops', 'supervisor.token')
    await mkdir(path.dirname(supervisorTokenFile), { recursive: true })
    await mkdir(path.dirname(fixture.runtimeManifestPath), { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(supervisorTokenFile, 'test-token\n', 'utf8')
    await writeFile(fixture.runtimeManifestPath, JSON.stringify({
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot,
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:9000',
      supervisorTokenFile,
      allowedEnvironmentOverrides: [],
    }), 'utf8')

    await expect(fixture.service(vi.fn()).status()).resolves.toEqual({
      state: 'configured',
      deploymentMode: 'local_managed',
      apiBaseUrl: 'http://127.0.0.1:9000',
      canReset: false,
    })
  })
})

describe('parseDesktopApiBaseUrl', () => {
  it('normalizes origins and keeps plain HTTP limited to loopback services', () => {
    expect(parseDesktopApiBaseUrl(' https://geo.example.com/ ')).toBe('https://geo.example.com')
    expect(parseDesktopApiBaseUrl('http://localhost:8000')).toBe('http://localhost:8000')
    expect(() => parseDesktopApiBaseUrl('http://192.168.1.20:8000')).toThrow('必须使用 HTTPS')
    expect(() => parseDesktopApiBaseUrl('https://geo.example.com/api')).toThrow('不能包含 API 路径')
    expect(() => parseDesktopApiBaseUrl('https://user:pass@geo.example.com')).toThrow('不能包含账号')
  })
})

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-product-setup-'))
  temporaryDirectories.push(directory)
  const userSetupPath = path.join(directory, 'user', 'product-setup.v1.json')
  const runtimeManifestPath = path.join(directory, 'system', 'runtime-manifest.v1.json')
  await mkdir(path.dirname(userSetupPath), { recursive: true })
  return {
    directory,
    userSetupPath,
    runtimeManifestPath,
    service(fetch: (input: string, init?: RequestInit) => Promise<Response>, times?: number[]) {
      const readings = [...(times ?? [])]
      return new DesktopProductSetupService({
        profile: 'production',
        environment: {},
        applicationPath: directory,
        platform: 'linux',
        userSetupPath,
        runtimeManifestPath,
        manifestProtection: { expectedOwnerUid: process.getuid?.() ?? 0 },
        fetch,
        now: times ? () => readings.shift() ?? times.at(-1) ?? 0 : undefined,
      })
    },
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
