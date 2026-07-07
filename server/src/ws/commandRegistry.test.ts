// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 命令注册表测试
//
//   文件:       commandRegistry.test.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { WsCommandRegistry } from './commandRegistry.js'
import type { ClientMsg } from './protocol.js'

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
})

function message(type: ClientMsg['type'], payload: Record<string, unknown>): ClientMsg {
  return { id: 'test', type, payload }
}

function emptyContext(): Parameters<WsCommandRegistry['execute']>[1] {
  return {
    dependencies: {} as Parameters<WsCommandRegistry['execute']>[1]['dependencies'],
    runtime: {} as Parameters<WsCommandRegistry['execute']>[1]['runtime'],
    files: {} as Parameters<WsCommandRegistry['execute']>[1]['files'],
    ws: {} as Parameters<WsCommandRegistry['execute']>[1]['ws'],
    subscriptions: new Map(),
    auth: null,
  }
}
