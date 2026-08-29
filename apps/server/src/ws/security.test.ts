// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 运行配置授权测试
//
//   文件:       security.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { WsControlCommand } from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type { WsCommandContext, WsCommandRegistry } from './commandRegistry.js'
import { registerWsAuthorizationPolicies } from './security.js'

type Authorize = NonNullable<Parameters<WsCommandRegistry['setAuthorize']>[1]>

const localDesktopAuth: AuthContext = {
  userId: 'user_local_desktop',
  subject: 'auth_local_desktop',
  email: 'desktop@local-desktop.geo-agent-platform.invalid',
  displayName: '本机工作台',
  authSessionId: 'auth_session_local_desktop',
  authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'csrf_local_desktop',
  defaultWorkspaceId: 'workspace_local_desktop',
  roles: [{ workspaceId: 'workspace_local_desktop', role: 'analyst' }],
}

describe('WebSocket runtime configuration authorization', () => {
  it.each([
    ['provider:custom:list', 'read'],
    ['provider:credential:stage', 'update'],
    ['provider:custom:discover-models', 'update'],
    ['provider:custom:upsert', 'update'],
    ['provider:custom:delete', 'update'],
    ['tool-catalog:upsert', 'update'],
    ['tool-catalog:delete', 'update'],
    ['runtime-config:update', 'update'],
  ] as const)('grants the protected local desktop only %s configuration access', async (command, action) => {
    const { audit, enforce, invoke } = policyHarness()

    await invoke(command, localDesktopAuth)

    expect(enforce).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(
      localDesktopAuth,
      'runtime_config',
      action,
      { workspaceId: localDesktopAuth.defaultWorkspaceId },
      'allowed',
      { wsCommand: command, principalType: 'local_desktop' },
    )
  })

  it('keeps remote analyst configuration access behind Casbin and records the concrete command', async () => {
    const { enforce, invoke } = policyHarness()
    const remoteAnalyst: AuthContext = {
      ...localDesktopAuth,
      userId: 'user_remote_analyst',
      subject: 'auth_remote_analyst',
      email: 'analyst@example.com',
    }

    await invoke('tool-catalog:upsert', remoteAnalyst)

    expect(enforce).toHaveBeenCalledWith(
      remoteAnalyst,
      'runtime_config',
      'update',
      { workspaceId: remoteAnalyst.defaultWorkspaceId },
      { wsCommand: 'tool-catalog:upsert' },
    )
  })
})

function policyHarness(): {
  authorizers: Map<string, Authorize>
  audit: ReturnType<typeof vi.fn>
  enforce: ReturnType<typeof vi.fn>
  invoke(command: WsControlCommand, auth: AuthContext): Promise<void>
} {
  const authorizers = new Map<string, Authorize>()
  const registry = {
    setAuthorize: vi.fn((type: string, authorize: Authorize) => {
      authorizers.set(type, authorize)
    }),
  } as unknown as WsCommandRegistry
  const audit = vi.fn(async () => undefined)
  const enforce = vi.fn(async () => undefined)
  registerWsAuthorizationPolicies(registry)
  return {
    authorizers,
    audit,
    enforce,
    async invoke(command, auth) {
      const authorize = authorizers.get(command)
      if (!authorize) throw new Error(`命令 '${command}' 没有授权策略。`)
      await authorize({}, {
        msg: { type: command, id: 'request_test', payload: {} },
        auth,
        dependencies: {
          security: {
            auth: { isAuthContextActive: vi.fn(async () => true) },
            authorization: { audit, enforce },
          },
        },
      } as unknown as WsCommandContext)
    },
  }
}
