// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面运行时认证配置测试
//
//   文件:       runtimeConfig.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  defaultDesktopRuntimeManifestPath,
  resolveDesktopAutoAuthConfig,
  resolveDesktopRuntimeConfig,
} from './runtimeConfig.js'

describe('resolveDesktopAutoAuthConfig', () => {
  const runtimeRoot = path.resolve('runtime-test')

  it('enables the matching bootstrap administrator by default in development', () => {
    const config = resolveDesktopAutoAuthConfig({
      environment: {
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH_EMAIL: 'ADMIN@example.com',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        BETTER_AUTH_ALLOW_SIGN_UP: 'true',
      },
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })

    expect(config).toEqual({
      email: 'admin@example.com',
      displayName: `${PRODUCT_CODENAME} 本机演示管理员`,
      credentialFile: path.join(runtimeRoot, 'desktop', 'auto-auth.secret'),
      allowAccountCreation: true,
    })
  })

  it('restores interactive login when development auto auth is explicitly disabled', () => {
    expect(resolveDesktopAutoAuthConfig({
      environment: {
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'false',
      },
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toBeNull()
  })

  it('rejects remote APIs and production activation', () => {
    const environment = {
      GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'true',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
    }
    expect(() => resolveDesktopAutoAuthConfig({
      environment,
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'https://api.example.com',
    })).toThrow('回环 API')
    expect(() => resolveDesktopAutoAuthConfig({
      environment,
      profile: 'production',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toThrow('development')
  })

  it('does not let APP_ENV downgrade a production profile into development auto auth', () => {
    expect(() => resolveDesktopAutoAuthConfig({
      environment: {
        APP_ENV: 'development',
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'true',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      },
      profile: 'production',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toThrow('development')
  })

  it('rejects a client-side account that differs from the server bootstrap identity', () => {
    expect(() => resolveDesktopAutoAuthConfig({
      environment: {
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'true',
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH_EMAIL: 'other@example.com',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      },
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'http://localhost:8000',
    })).toThrow('BOOTSTRAP_ADMIN_EMAIL')
  })
})

describe('resolveDesktopRuntimeConfig', () => {
  it('uses the protected production manifest instead of ambient legacy variables', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-config-'))
    try {
      const runtimeRoot = path.join(directory, 'runtime')
      const projectRoot = path.join(directory, 'project')
      const supervisorTokenFile = path.join(runtimeRoot, 'secrets', 'supervisor.token')
      const manifestPath = path.join(directory, 'runtime-manifest.v1.json')
      await mkdir(projectRoot, { recursive: true })
      await mkdir(path.dirname(supervisorTokenFile), { recursive: true })
      await writeFile(supervisorTokenFile, 'test-supervisor-token\n', 'utf8')
      await writeFile(manifestPath, JSON.stringify({
        kind: 'geo-agent-platform.desktop-runtime',
        schemaVersion: 1,
        projectRoot,
        runtimeRoot,
        apiBaseUrl: 'http://127.0.0.1:8123',
        supervisorTokenFile,
        allowedEnvironmentOverrides: [],
      }), 'utf8')

      const config = resolveDesktopRuntimeConfig({
        API_PORT: '9999',
      }, {
        profile: 'production',
        platform: 'win32',
        runtimeManifestPath: manifestPath,
      })

      expect(config).toMatchObject({
        profile: 'production',
        projectRoot,
        runtimeRoot,
        apiBaseUrl: 'http://127.0.0.1:8123',
        supervisorTokenFile,
        runtimeManifestPath: manifestPath,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses a fixed system manifest location that ambient ProgramData cannot redirect', () => {
    expect(defaultDesktopRuntimeManifestPath('win32', {
      ProgramData: path.win32.join('C:\\', 'ProgramData'),
    }))
      .toBe(path.win32.join('C:\\ProgramData', PLATFORM_TECHNICAL_ID, 'runtime-manifest.v1.json'))
    expect(defaultDesktopRuntimeManifestPath('linux'))
      .toBe('/etc/geo-agent-platform/runtime-manifest.v1.json')
  })

  it('requires the Windows system configuration root instead of embedding a project path', () => {
    expect(defaultDesktopRuntimeManifestPath('win32', {
      ProgramData: path.win32.join('C:\\', 'ProgramData'),
    })).toBe(path.win32.join('C:\\ProgramData', PLATFORM_TECHNICAL_ID, 'runtime-manifest.v1.json'))
    expect(() => defaultDesktopRuntimeManifestPath('win32', {}))
      .toThrow('ProgramData')
  })
})
