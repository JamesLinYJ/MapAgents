// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区启动指针测试
//
//   文件:       workspaceBootstrapPointer.test.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { WorkspaceBootstrapSnapshot } from '@geo-agent-platform/shared-types'

import { loadBootstrapFromWorkspacePointer } from '../app/useWorkspaceBootstrap'

describe('loadBootstrapFromWorkspacePointer', () => {
  it('优先使用可访问的分享 session', async () => {
    const calls: Array<string | undefined> = []
    const result = await loadBootstrapFromWorkspacePointer('session_shared', async sessionId => {
      calls.push(sessionId)
      return snapshot(sessionId ?? 'session_default')
    })

    expect(result.pointerRejected).toBe(false)
    expect(result.snapshot.session.id).toBe('session_shared')
    expect(calls).toEqual(['session_shared'])
  })

  it('分享 session 不可访问时回到当前用户默认 session', async () => {
    const calls: Array<string | undefined> = []
    const result = await loadBootstrapFromWorkspacePointer('session_foreign', async sessionId => {
      calls.push(sessionId)
      if (sessionId === 'session_foreign') throw new Error("无权限对 session 'session_foreign' 执行 read。")
      return snapshot(sessionId ?? 'session_default')
    })

    expect(result.pointerRejected).toBe(true)
    expect(result.snapshot.session.id).toBe('session_default')
    expect(calls).toEqual(['session_foreign', undefined])
  })
})

function snapshot(sessionId: string): WorkspaceBootstrapSnapshot {
  const now = '2026-07-07T00:00:00.000Z'
  return {
    auth: {
      user: {
        userId: 'user_1',
        subject: 'user_1',
        email: 'user@example.com',
        displayName: '测试用户',
        status: 'active',
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      },
      defaultWorkspace: {
        workspaceId: 'workspace_1',
        name: '个人工作区',
        description: '',
        status: 'active',
        createdByUserId: 'user_1',
        createdAt: now,
        updatedAt: now,
      },
      memberships: [],
      platformRoles: [],
      csrfToken: 'csrf',
      permissions: [],
    },
    session: {
      id: sessionId,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'private',
      createdAt: now,
      status: 'active',
      shareToken: 'share',
      latestThreadId: null,
      latestRunId: null,
      latestUploadedLayerKey: null,
      latestMeteorologicalDatasetId: null,
    },
    threads: [],
    providers: [],
  }
}
