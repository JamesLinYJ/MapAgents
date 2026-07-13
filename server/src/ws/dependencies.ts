// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 依赖边界
//
//   文件:       dependencies.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// WebSocket 控制面只接收显式注入的服务依赖。这个类型是 handler、授权策略和
// 命令执行模块之间的共享边界，避免各模块直接导入应用启动层的全局对象。

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { Env } from '../framework/env.js'
import type { PostGisRepository } from '../gis/postgis.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { SandboxSessionFactory } from '../agent/runtime.js'
import type { OpenAIAgentsRuntime } from '../agent/runtime.js'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import type { SecurityServices } from '../security/routes.js'
import type { ScheduledTaskService } from '../workflows/scheduledTaskService.js'
import type { WorkflowDefinitionService } from '../workflows/workflowDefinitionService.js'
import type { BackgroundTaskRegistry } from '../workflows/backgroundTaskRegistry.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'

export interface WsDependencies {
  env: Env
  store: PostgresPlatformStore
  toolRegistry: ToolRegistry
  modelRegistry: ModelAdapterRegistry
  postgis: PostGisRepository
  runtimeRoot: string
  defaultRuntimeConfig?: AgentRuntimeConfig
  createSandboxSession?: SandboxSessionFactory
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
  scheduledTaskService: ScheduledTaskService
  workflowDefinitionService: WorkflowDefinitionService
  backgroundTasks: BackgroundTaskRegistry
  usageStats: UsageStatsService
  security: SecurityServices
}
