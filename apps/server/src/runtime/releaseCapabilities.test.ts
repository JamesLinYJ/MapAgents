// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务发布能力清单测试
//
//   文件:       releaseCapabilities.test.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { buildRuntimeCapabilities, resolveReleaseId } from './releaseCapabilities.js'

describe('runtime release capabilities', () => {
  it('uses an explicit release id when a service artifact provides one', () => {
    expect(resolveReleaseId({ GEO_AGENT_PLATFORM_RELEASE_ID: 'release-2026.08.04' })).toBe('release-2026.08.04')
  })

  it('publishes a schema-validated capability handshake', () => {
    const capabilities = buildRuntimeCapabilities({
      workerContractDigest: `sha256:${'a'.repeat(64)}`,
      environment: { GEO_AGENT_PLATFORM_RELEASE_ID: 'test-release' },
    })
    expect(capabilities).toMatchObject({
      releaseId: 'test-release',
      apiProtocolVersion: 1,
      minDesktopProtocol: 1,
      maxDesktopProtocol: 1,
      workerContractDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(() => buildRuntimeCapabilities({
      workerContractDigest: 'not-a-digest',
      environment: { GEO_AGENT_PLATFORM_RELEASE_ID: 'test-release' },
  })).toThrow()
})
})
