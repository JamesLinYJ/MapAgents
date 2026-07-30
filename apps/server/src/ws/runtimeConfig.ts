// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 运行时配置解析
//
//   文件:       runtimeConfig.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// WebSocket 命令和后台工具执行共享同一个运行时配置读取边界。数据库配置是事实源；
// 未写入配置时才使用进程启动时注入的默认配置。

import { agentRuntimeConfigSchema, type AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'

export async function resolveRuntimeConfig(
  store: PlatformPersistenceFacade,
  fallbackConfig: AgentRuntimeConfig = defaultRuntimeConfig(),
): Promise<AgentRuntimeConfig> {
  const stored = await store.getRuntimeConfig('agent-runtime')
  return stored ? agentRuntimeConfigSchema.parse(stored) : agentRuntimeConfigSchema.parse(fallbackConfig)
}
