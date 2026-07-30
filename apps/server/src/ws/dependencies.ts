// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 依赖边界
//
//   文件:       dependencies.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// WebSocket 控制面只接收显式注入的服务依赖。这个类型是 handler、授权策略和
// 命令执行模块之间的共享边界，避免各模块直接导入应用启动层的全局对象。

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { Env } from '../framework/env.js'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ModelCompletionService } from '../model/modelResultCache.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { SandboxClientFactory } from '../agent/runtime.js'
import type { OpenAIAgentsRuntime } from '../agent/runtime.js'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { SecurityServices } from '../security/routes.js'
import type { ScheduledTaskService } from '../automations/scheduledTaskService.js'
import type { AutomationDefinitionService } from '../automations/automationDefinitionService.js'
import type { BackgroundTaskRegistry } from '../automations/backgroundTaskRegistry.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import type { MapStore } from '../store/postgres/mapStore.js'

export interface WsDependencies {
  env: Env
  store: PlatformPersistenceFacade
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  modelCompletions?: ModelCompletionService
  managedLayers: ManagedLayerService
  runtimeRoot: string
  defaultRuntimeConfig?: AgentRuntimeConfig
  createSandboxClient?: SandboxClientFactory
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
  scheduledTaskService: ScheduledTaskService
  automationDefinitionService: AutomationDefinitionService
  backgroundTasks: BackgroundTaskRegistry
  usageStats: UsageStatsService
  mapStore: MapStore
  security: SecurityServices
}
