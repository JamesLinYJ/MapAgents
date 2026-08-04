// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时配置解析
//
//   运行时配置是应用服务和传输适配器共享的边界；它不属于 WS 实现。
// --------------------------------------------------------------------------

import { agentRuntimeConfigSchema, type AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import type { RuntimeConfigStore } from '../store/postgres/runtimeConfigStore.js'

export async function resolveRuntimeConfig(
  store: Pick<RuntimeConfigStore, 'getRuntimeConfig'>,
  fallbackConfig: AgentRuntimeConfig = defaultRuntimeConfig(),
): Promise<AgentRuntimeConfig> {
  const stored = await store.getRuntimeConfig('agent-runtime')
  return stored ? agentRuntimeConfigSchema.parse(stored) : agentRuntimeConfigSchema.parse(fallbackConfig)
}
