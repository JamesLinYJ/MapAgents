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
import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { AuthContext } from '../security/types.js'
import type { RuntimeFileStore } from '../store/fileStore.js'
import type { ClientMsg } from './protocol.js'
import type { WsDependencies } from './dependencies.js'

export interface WsCommandContext {
  msg: ClientMsg
  dependencies: WsDependencies
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
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
  authorize?: (payload: Record<string, unknown>, context: WsCommandContext) => Promise<void> | void
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

  setAuthorize(
    type: ClientMsg['type'],
    authorize: NonNullable<WsCommandDefinition['authorize']>,
  ): void {
    const definition = this.get(type)
    if (!definition) throw new Error(`WS 命令 '${type}' 尚未注册，不能挂载授权策略`)
    definition.authorize = authorize
  }

  async execute(msg: ClientMsg, context: Omit<WsCommandContext, 'msg'>): Promise<unknown> {
    const definition = this.get(msg.type)
    if (!definition) throw new Error(`WS 命令 '${msg.type}' 尚未注册`)
    if ((definition.auth ?? 'required') === 'required' && !context.auth) {
      throw new Error('WebSocket 命令需要登录。')
    }
    const parsedPayload = definition.payloadSchema.parse(msg.payload)
    const commandContext = { ...context, msg }
    if (!definition.authorize) throw new Error(`WS 命令 '${msg.type}' 缺少授权策略。`)
    await definition.authorize(requireRecordPayload(parsedPayload, msg.type), commandContext)
    return definition.handler(parsedPayload, commandContext)
  }

  registeredTypes(): ClientMsg['type'][] {
    return [...this.commands.keys()]
  }

  commandsWithoutAuthorization(): ClientMsg['type'][] {
    return [...this.commands.values()]
      .filter(definition => !definition.authorize)
      .map(definition => definition.type)
  }
}

function requireRecordPayload(payload: unknown, type: ClientMsg['type']): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`WS 命令 '${type}' payload 必须是对象。`)
  }
  return payload as Record<string, unknown>
}
