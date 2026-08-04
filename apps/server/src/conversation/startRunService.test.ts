// +-------------------------------------------------------------------------
//
//   地理智能平台 - StartRun 应用服务测试
//
//   文件:       startRunService.test.ts
//
//   日期:       2026年08月04日
// --------------------------------------------------------------------------

import type { AnalysisRun } from '@geo-agent-platform/shared-types/platform'
import { describe, expect, it, vi } from 'vitest'

import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import type { AuthContext } from '../security/types.js'
import { StartRunService } from './startRunService.js'

describe('StartRunService', () => {
  it('resolves a thread session, snapshots runtime config, and starts one detached task', async () => {
    const runtimeConfig = defaultRuntimeConfig()
    const run = fakeRun({ threadId: 'thread_existing', modelProvider: 'deepseek' })
    const startDetached = vi.fn()
    const createRun = vi.fn().mockResolvedValue(run)
    const service = new StartRunService({
      store: {
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig) },
        getThread: vi.fn(() => ({ sessionId: 'session_from_thread' } as never)),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: 'deepseek' },
      runTasks: { startDetached },
    })

    const result = await service.start({
      auth: testAuth(),
      query: '查询杭州天气',
      threadId: 'thread_existing',
      provider: null,
      executionMode: 'auto',
    })

    expect(result).toBe(run)
    expect(createRun).toHaveBeenCalledWith('session_from_thread', '查询杭州天气', {
      threadId: 'thread_existing',
      modelProvider: 'deepseek',
      modelName: null,
      runtimeConfigSnapshot: runtimeConfig,
    })
    expect(startDetached).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      sessionId: 'session_from_thread',
      threadId: 'thread_existing',
      provider: 'deepseek',
      runtimeConfig,
    }), undefined)
  })

  it('fails before creating a run when no provider is configured', async () => {
    const createRun = vi.fn()
    const service = new StartRunService({
      store: {
        runtimeConfiguration: { getRuntimeConfig: vi.fn().mockResolvedValue(null) },
        getThread: vi.fn(),
        createThread: vi.fn(),
        createRun,
      },
      usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
      modelRegistry: { defaultProvider: '' },
      runTasks: { startDetached: vi.fn() },
    })

    await expect(service.start({
      auth: testAuth(),
      query: '没有 provider',
      sessionId: 'session_1',
    })).rejects.toThrow('必须显式指定模型 provider')
    expect(createRun).not.toHaveBeenCalled()
  })
})

function fakeRun(overrides: Partial<AnalysisRun>): AnalysisRun {
  return {
    id: 'run_1',
    threadId: null,
    sessionId: 'session_1',
    workspaceId: null,
    createdByUserId: 'user_1',
    visibility: 'private',
    userQuery: 'query',
    modelProvider: null,
    modelName: null,
    status: 'queued',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    state: {} as AnalysisRun['state'],
    conversationPath: null,
    runtimeConfigSnapshot: null,
    ...overrides,
  }
}

function testAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: 'Test User',
    authSessionId: 'session_auth_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_1',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
  }
}
