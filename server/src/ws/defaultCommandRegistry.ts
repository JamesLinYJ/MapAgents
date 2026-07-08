// +-------------------------------------------------------------------------
//
//   地理智能平台 - 默认 WS 命令注册表
//
//   文件:       defaultCommandRegistry.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { WsCommandRegistry } from './commandRegistry.js'
import { registerControlCommands } from './controlCommands.js'
import { registerCoreCommands } from './coreCommands.js'
import { registerMemoryCommands } from './memoryCommand.js'
import { registerRunCommands } from './runCommands.js'
import { registerWsAuthorizationPolicies } from './security.js'
import { registerThreadCommands } from './threadCommands.js'
import { registerThreadContextCommands } from './threadContextCommands.js'
import { registerToolCommands } from './toolCommand.js'
import { registerWorkspaceCommands } from './workspaceCommands.js'

// 所有 WS 控制命令必须从这里注册。handler 只持有这个注册表，不再知道
// 任何具体业务命令，测试也能直接验证协议枚举与注册表完全一致。
export function createDefaultCommandRegistry(): WsCommandRegistry {
  const registry = new WsCommandRegistry()
  registerCoreCommands(registry)
  registerWorkspaceCommands(registry)
  registerThreadCommands(registry)
  registerThreadContextCommands(registry)
  registerControlCommands(registry)
  registerRunCommands(registry)
  registerMemoryCommands(registry)
  registerToolCommands(registry)
  registerWsAuthorizationPolicies(registry)
  const missingAuthorization = registry.commandsWithoutAuthorization()
  if (missingAuthorization.length) {
    throw new Error(`以下 WS 命令缺少授权策略：${missingAuthorization.join('、')}`)
  }
  return registry
}
