// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket CQRS 命令类型
//
//   文件:       commandTypes.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 显式区分 Command（写操作/副作用）和 Query（只读）。
// 当前 handler 中混合的读写路径通过此类型系统分离。
// Query 可并发执行，Command 必须串行化且需 approval gating。

import type { WsCommandDefinition } from './commandRegistry.js'

export type CommandCategory = 'read' | 'write' | 'admin'

// 标记命令的读写属性
export function categorizeCommand(name: string): CommandCategory {
  if (name.startsWith('run:start') || name.startsWith('run:cancel')
    || name === 'run:steer'
    || name === 'run:respond-decision'
    || name === 'thread:create' || name === 'thread:update'
    || name === 'thread:delete' || name === 'thread:fork'
    || name === 'thread:memory:update' || name === 'thread:memory:rebuild'
    || name === 'thread:trash:restore' || name === 'thread:trash:purge'
    || name === 'tool:run'
    || name === 'tool-catalog:upsert' || name === 'tool-catalog:delete'
    || name === 'runtime-config:update'
    || name === 'memory:write' || name === 'memory:delete'
    || name === 'memory:extract' || name === 'memory:dream'
    || name === 'memory:session:rebuild'
    || name === 'file:delete'
    || name === 'layer:update' || name === 'layer:delete'
    || name === 'map-scene:update'
  ) {
    return 'write'
  }

  if (name === 'workspace:bootstrap'
    || name === 'speech:authorization'
    || name === 'runtime-config:update'
  ) {
    return 'admin'
  }

  return 'read'
}

export function isWriteCommand(definition: WsCommandDefinition): boolean {
  return categorizeCommand(definition.type) === 'write'
}

export function isReadCommand(definition: WsCommandDefinition): boolean {
  return categorizeCommand(definition.type) === 'read'
}
