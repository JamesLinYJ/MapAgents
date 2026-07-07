// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 命令注册表
//
//   文件:       commandRegistry.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { WebSocket } from 'ws'
import type { z } from 'zod'

import type { OpenAIAgentsRuntime } from '../agent/runtime.js'
import type { AuthContext } from '../security/types.js'
import type { RuntimeFileStore } from '../store/fileStore.js'
import type { ClientMsg } from './protocol.js'
import type { WsDependencies } from './dependencies.js'

export interface WsCommandContext {
  msg: ClientMsg
  dependencies: WsDependencies
  runtime: OpenAIAgentsRuntime
  files: RuntimeFileStore
  ws: WebSocket
  subscriptions: Map<string, () => void>
  auth: AuthContext | null
}

export interface WsCommandDefinition<TPayload extends z.ZodTypeAny = z.ZodTypeAny> {
  type: ClientMsg['type']
  payloadSchema: TPayload
  auth?: 'required' | 'optional'
  csrf?: boolean
  handler: (payload: z.infer<TPayload>, context: WsCommandContext) => Promise<unknown> | unknown
}

// 注册表是 WS 控制面的唯一新增入口。它把 payload schema、auth 要求和
// handler 绑定在一起，避免命令继续散落在大型 switch 和手写 payload 解析中。
export class WsCommandRegistry {
  private readonly commands = new Map<ClientMsg['type'], WsCommandDefinition>()

  register<TPayload extends z.ZodTypeAny>(definition: WsCommandDefinition<TPayload>): void {
    if (this.commands.has(definition.type)) {
      throw new Error(`WS 命令 '${definition.type}' 重复注册`)
    }
    this.commands.set(definition.type, definition)
  }

  get(type: ClientMsg['type']): WsCommandDefinition | null {
    return this.commands.get(type) ?? null
  }

  async execute(msg: ClientMsg, context: Omit<WsCommandContext, 'msg'>): Promise<unknown> {
    const definition = this.get(msg.type)
    if (!definition) throw new Error(`WS 命令 '${msg.type}' 尚未注册`)
    if ((definition.auth ?? 'required') === 'required' && !context.auth) {
      throw new Error('WebSocket 命令需要登录。')
    }
    const parsedPayload = definition.payloadSchema.parse(msg.payload)
    return definition.handler(parsedPayload, { ...context, msg })
  }

  registeredTypes(): ClientMsg['type'][] {
    return [...this.commands.keys()]
  }
}
