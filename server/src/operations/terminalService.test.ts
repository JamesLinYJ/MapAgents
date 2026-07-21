// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维终端应用服务测试
//
//   文件:       terminalService.test.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OpsTerminalSession } from '@geo-agent-platform/shared-types/operations'
import { ContentAddressedObjectStore } from '../store/contentAddressedObjectStore.js'
import type { PostgresObjectReferenceRepository } from '../store/postgres/objectReferenceRepository.js'
import type { TerminalKeyring } from './keyring.js'
import type { TerminalBrokerClient } from './terminalBrokerClient.js'
import { encryptTranscriptChunk } from './terminalRecording.js'
import type { TerminalRepository } from './terminalRepository.js'
import { TerminalService } from './terminalService.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TerminalService 记录授权', () => {
  it('为其他管理员签发 5 分钟授权并完整记录理由', async () => {
    const repository = {
      getSession: vi.fn(async () => terminalSession('owner-user')),
      createAccessGrant: vi.fn(async () => 'grant-1'),
    }
    const audit = { recordEvent: vi.fn(async () => undefined) }
    const service = await createService({ repository, audit })
    const before = Date.now()

    const grant = await service.grantTranscriptAccess({
      actor: { userId: 'reviewer-user', displayName: '复核管理员' },
      terminalId: 'terminal-1',
      reason: '调查主 API 重启失败的完整过程',
    })

    expect(grant.grantId).toBe('grant-1')
    expect(Date.parse(grant.expiresAt)).toBeGreaterThanOrEqual(before + 299_000)
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.now() + 301_000)
    expect(repository.createAccessGrant).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: 'terminal-1',
      grantedToUserId: 'reviewer-user',
      reason: '调查主 API 重启失败的完整过程',
    }))
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ops.transcript.access_granted',
      actorUserId: 'reviewer-user',
      metadata: expect.objectContaining({ reason: '调查主 API 重启失败的完整过程' }),
    }))
  })

  it('一次性消费他人记录授权，第二次读取被拒绝', async () => {
    const runtimeRoot = await createTemporaryDirectory()
    const terminalId = 'terminal-1'
    const dataKey = randomBytes(32)
    const encrypted = encryptTranscriptChunk({
      terminalId,
      sequence: 0,
      dataKey,
      events: [[0.1, 'o', '加密回放内容\r\n']],
    }).encrypted
    const reference = await new ContentAddressedObjectStore(
      path.join(runtimeRoot, 'objects', 'sha256'),
    ).put(encrypted, 'application/vnd.geoforge.terminal-chunk')
    const consumeAccessGrant = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const repository = {
      getSessionSecret: vi.fn(async () => ({
        terminalId,
        ownerUserId: 'owner-user',
        shell: 'pwsh',
        initialCols: 120,
        initialRows: 32,
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
        keyId: 'key-1',
        wrappedDataKey: 'wrapped',
        keyWrapNonce: 'nonce',
        keyWrapAuthTag: 'tag',
      })),
      consumeAccessGrant,
      listChunks: vi.fn(async () => [{
        terminalId,
        sequence: 0,
        contentHash: reference.hash,
        sizeBytes: encrypted.byteLength,
        eventCount: 1,
        firstEventMilliseconds: 100,
        lastEventMilliseconds: 100,
        createdAt: new Date('2026-07-21T00:00:01.000Z'),
      }]),
    }
    const audit = { recordEvent: vi.fn(async () => undefined) }
    const keyring = { unwrap: vi.fn(() => Buffer.from(dataKey)), activeKeyId: 'key-1' }
    const service = await createService({ runtimeRoot, repository, audit, keyring })
    const request = {
      actor: { userId: 'reviewer-user', displayName: '复核管理员' },
      terminalId,
      grantId: 'grant-1',
      disposition: 'inline' as const,
    }

    const response = await service.createCastResponse(request)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('加密回放内容')
    expect(consumeAccessGrant).toHaveBeenCalledTimes(1)
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ops.transcript.read',
      metadata: expect.objectContaining({ grantId: 'grant-1' }),
    }))

    await expect(service.createCastResponse(request)).rejects.toMatchObject({ status: 403 })
    expect(consumeAccessGrant).toHaveBeenCalledTimes(2)
    dataKey.fill(0)
  })
})

async function createService(input: {
  runtimeRoot?: string
  repository: object
  audit: { recordEvent: ReturnType<typeof vi.fn> }
  keyring?: object
}): Promise<TerminalService> {
  const runtimeRoot = input.runtimeRoot ?? await createTemporaryDirectory()
  return new TerminalService({
    runtimeRoot,
    repository: input.repository as unknown as TerminalRepository,
    broker: {} as TerminalBrokerClient,
    keyring: (input.keyring ?? {}) as TerminalKeyring,
    audit: input.audit,
    objectReferences: { listReferencedObjectHashes: vi.fn(async () => []) } as unknown as PostgresObjectReferenceRepository,
  })
}

function terminalSession(ownerUserId: string): OpsTerminalSession {
  return {
    terminalId: 'terminal-1',
    ownerUserId,
    ownerDisplayName: '记录创建者',
    label: '故障排查',
    state: 'exited',
    shell: 'pwsh',
    cols: 120,
    rows: 32,
    pid: null,
    exitCode: 0,
    recordedBytes: 100,
    createdAt: '2026-07-21T00:00:00.000Z',
    startedAt: '2026-07-21T00:00:00.000Z',
    detachedAt: null,
    expiresAt: '2026-07-21T08:00:00.000Z',
    endedAt: '2026-07-21T00:01:00.000Z',
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geoforge-terminal-service-'))
  temporaryDirectories.push(directory)
  return directory
}
