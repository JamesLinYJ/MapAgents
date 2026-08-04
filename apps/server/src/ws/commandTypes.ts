// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket CQRS 命令类型
//
//   文件:       commandTypes.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 显式区分 Command（写操作/副作用）和 Query（只读）。
// 当前 handler 中混合的读写路径通过此类型系统分离。
// Query 可并发执行，Command 必须串行化且需 approval gating。

import type { WsCommandDefinition } from './commandRegistry.js'
import { wsCommandContract, type WsControlCommand } from '@geo-agent-platform/shared-types'

export type CommandCategory = 'read' | 'write' | 'admin'

// 标记命令的读写属性
export function categorizeCommand(name: WsControlCommand): CommandCategory {
  return wsCommandContract(name).category
}

export function isWriteCommand(definition: WsCommandDefinition): boolean {
  return categorizeCommand(definition.type) === 'write'
}

export function isReadCommand(definition: WsCommandDefinition): boolean {
  return categorizeCommand(definition.type) === 'read'
}
