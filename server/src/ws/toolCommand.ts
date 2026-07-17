// GeoForge WS 直接工具执行命令。
// 管理员调试入口和 Workflow 工具节点共享 executePersistedTool；这里只拥有权限、运行创建和终态。

import { z } from 'zod'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import { assertDirectToolRunAllowed } from '../security/toolExecutionPolicy.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { executePersistedTool } from '../tools/persistentToolExecutor.js'
import { optionalString, requiredRecord, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const toolRunPayloadSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  runId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).strict()

export function registerToolCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'tool:run',
    payloadSchema: toolRunPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => executeTool(
      payload,
      context.dependencies.store,
      context.dependencies.toolRegistry,
      context.dependencies.modelRegistry,
      context.dependencies.defaultRuntimeConfig,
      context.dependencies.security,
      requireAuth(context.auth),
    ),
  })
}

export async function executeTool(
  payload: Record<string, unknown>,
  store: PlatformPersistenceFacade,
  registry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
  runtimeConfigDefaults: AgentRuntimeConfig | undefined,
  security: SecurityServices,
  auth: AuthContext,
) {
  const toolName = requiredString(payload, 'toolName')
  await assertDirectToolRunAllowed(auth, security.authorization, registry, toolName)
  const tool = registry.get(toolName)
  if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
  let runId = optionalString(payload.runId)
  let directRun = false
  if (!runId) {
    const sessionId = requiredString(payload, 'sessionId')
    let threadId = optionalString(payload.threadId)
    if (!threadId) threadId = (await store.createThread(sessionId, `工具：${tool.label}`)).id
    const created = await store.createRun(sessionId, `执行工具：${tool.label}`, {
      threadId,
      modelProvider: modelRegistry.defaultProvider || null,
      runtimeConfigSnapshot: await resolveRuntimeConfig(store, runtimeConfigDefaults),
    })
    runId = created.id
    directRun = true
    await store.updateRunStatus(runId, 'running')
  }
  try {
    const result = await executePersistedTool({
      runId,
      toolName,
      args: requiredRecord(payload, 'args'),
      auth,
    }, {
      store,
      registry,
      modelRegistry,
      defaultRuntimeConfig: runtimeConfigDefaults,
    })
    if (directRun) await store.completeRun(runId, 'completed')
    return { result, run: store.getRun(runId) }
  } catch (error) {
    if (directRun) {
      const run = store.getRun(runId)
      const message = error instanceof Error && error.message.trim() ? error.message : '工具执行失败。'
      await store.updateRunState(runId, { errors: [...run.state.errors, message], failedTool: toolName })
      await store.completeRun(runId, 'failed')
    }
    throw error
  }
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
