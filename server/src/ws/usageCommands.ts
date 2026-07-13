// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 用量统计命令
//
//   文件:       usageCommands.ts
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerUsageCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'usage:summary',
    payloadSchema: z.object({}).passthrough(),
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.usageStats.summarizeWorkspace(requireAuth(context.auth)),
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
