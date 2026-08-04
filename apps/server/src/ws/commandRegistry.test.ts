// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 命令注册表测试
//
//   文件:       commandRegistry.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { createDefaultCommandRegistry } from './defaultCommandRegistry.js'
import { WsCommandRegistry } from './commandRegistry.js'
import { clientMsgType, type ClientMsg } from './protocol.js'
import type { AuthContext } from '../security/types.js'
import { wsCommandContracts } from '@geo-agent-platform/shared-types'

describe('WsCommandRegistry', () => {
  it('rejects duplicate command registration', () => {
    const registry = new WsCommandRegistry()
    const definition = {
      type: 'provider:list' as const,
      payloadSchema: z.object({}).passthrough(),
      handler: () => [],
    }

    registry.register(definition)

    expect(() => registry.register(definition)).toThrow("WS 命令 'provider:list' 重复注册")
  })

  it('validates payload schema before executing handlers', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'session:get' as const,
      payloadSchema: z.object({ sessionId: z.string().min(1) }).passthrough(),
      handler: payload => payload.sessionId,
    })

    await expect(registry.execute(message('session:get', { sessionId: '' }), emptyContext()))
      .rejects.toThrow()
  })

  it('requires authenticated context for required commands', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'tool:list' as const,
      payloadSchema: z.object({}).passthrough(),
      auth: 'required',
      handler: () => [],
    })

    await expect(registry.execute(message('tool:list', {}), emptyContext()))
      .rejects.toThrow('WebSocket 命令需要登录。')
  })

  it('rejects authenticated commands without an authorization policy', async () => {
    const registry = new WsCommandRegistry()
    registry.register({
      type: 'tool:list' as const,
      payloadSchema: z.object({}).passthrough(),
      auth: 'required',
      handler: () => [],
    })

    await expect(registry.execute(message('tool:list', {}), emptyContext(fakeAuth())))
      .rejects.toThrow("WS 命令 'tool:list' 缺少授权策略。")
  })

  it('registers every protocol command exactly once', () => {
    const registry = createDefaultCommandRegistry()
    expect(new Set(registry.registeredTypes())).toEqual(new Set(clientMsgType.options))
  })

  it('attaches a shared response contract to every registered command', () => {
    const registry = createDefaultCommandRegistry()
    for (const type of clientMsgType.options) {
      const definition = registry.get(type)
      expect(definition?.responseSchema).toBe(wsCommandContracts[type].response)
      expect(definition?.responseSchema).toBeDefined()
    }
  })
})

function message(type: ClientMsg['type'], payload: Record<string, unknown>): ClientMsg {
  return { id: 'test', type, payload }
}

function emptyContext(auth: AuthContext | null = null): Parameters<WsCommandRegistry['execute']>[1] {
  return {
    dependencies: {} as Parameters<WsCommandRegistry['execute']>[1]['dependencies'],
    runtime: {} as Parameters<WsCommandRegistry['execute']>[1]['runtime'],
    files: {} as Parameters<WsCommandRegistry['execute']>[1]['files'],
    ws: {} as Parameters<WsCommandRegistry['execute']>[1]['ws'],
    subscriptions: new Map(),
    auth,
  }
}

function fakeAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'test@example.com',
    displayName: 'Test User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
  }
}
