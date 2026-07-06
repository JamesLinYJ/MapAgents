// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 工具执行命令
//
//   文件:       toolCommand.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 只承载 tool:run 的直接执行路径。普通用户的 Agent 工具调用仍走 runtime 审批链；
// 这里必须先经过 ToolExecutionPolicy，再把结果按运行历史事实源落盘。

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext } from '../framework/types.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import { assertDirectToolRunAllowed } from '../security/toolExecutionPolicy.js'
import { ItemSink } from '../conversation/itemSink.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { PostgresPlatformStore } from '../store/platformStore.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from '../tools/resultPersistence.js'
import { formatError, isRecord, optionalString, requiredRecord, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'

export async function executeTool(
  payload: Record<string, unknown>,
  store: PostgresPlatformStore,
  registry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
  runtimeConfigDefaults: AgentRuntimeConfig | undefined,
  security: SecurityServices,
  auth: AuthContext,
) {
  const toolName = requiredString(payload, 'toolName')
  await assertDirectToolRunAllowed(auth, security.authorization, registry, toolName)
  let runId = optionalString(payload.runId)
  let directRun = false
  if (!runId) {
    const sessionId = requiredString(payload, 'sessionId')
    let threadId = optionalString(payload.threadId)
    if (!threadId) threadId = (await store.createThread(sessionId, `工具：${toolName}`)).id
    const created = await store.createRun(sessionId, `执行工具 ${toolName}`, {
      threadId,
      modelProvider: modelRegistry.defaultProvider || null,
      runtimeConfigSnapshot: await resolveRuntimeConfig(store, runtimeConfigDefaults),
    })
    runId = created.id
    directRun = true
    await store.updateRunStatus(runId, 'running')
  }
  const run = store.getRun(runId)
  const values = new Map(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
  const pendingToolLogWrites: Promise<void>[] = []
  const context: ToolContext = {
    runId,
    sessionId: run.sessionId,
    threadId: run.threadId,
    runtimeRoot: store.runtimeRoot,
    runtimeConfig: run.runtimeConfigSnapshot ?? await resolveRuntimeConfig(store, runtimeConfigDefaults),
    auth,
    state: values,
    resolveValueRef: refId => resolveRuntimeValueRef(values, refId),
    resolveMeteorologicalDataset: input => store.resolveMeteorologicalDataset({
      sessionId: run.sessionId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      datasetId: input.datasetId ?? null,
      filename: input.filename ?? null,
    }),
    invokeStructuredModel: async prompt => {
      const adapter = modelRegistry.resolveProvider(run.modelProvider)
      const response = await adapter.chat(prompt, { model: run.modelName ?? adapter.defaultModel, reasoning: false })
      const content = response.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回结构化内容')
      const parsed: unknown = JSON.parse(content.replace(/^```json\s*|\s*```$/gu, ''))
      if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object')
      return parsed
    },
    log: (_level, message) => {
      const persisted = store.appendEvent(runId, {
        eventId: makeId('event'), runId, threadId: run.threadId, type: 'tool.completed',
        message, timestamp: nowUtc(), payload: {},
      })
      pendingToolLogWrites.push(persisted)
      persisted.catch(error => logNonBlockingError('tool:run:log', error))
    },
  }
  const args = requiredRecord(payload, 'args')
  const callId = makeId('call')
  const itemSink = new ItemSink(item => store.appendItem(item), runId, run.threadId)
  const callItem = itemSink.startItem('function_call', {
    name: toolName,
    callId,
    arguments: JSON.stringify(args),
  })
  try {
    const result = await registry.execute(toolName, args, context)
    await persistToolExecutionResult(store, runId, toolName, args, result)
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: toolName,
      output: JSON.stringify(result.payload),
      metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    const outputItem = itemSink.startItem('function_call_output', {
      callId,
      name: toolName,
      role: 'tool',
      metadata: { resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    itemSink.completeItem(outputItem.itemId, {
      callId,
      name: toolName,
      output: JSON.stringify(result.payload),
      metadata: { resultId: result.resultId, source: result.source, valueRefs: result.valueRefs ?? [], artifacts: result.artifacts ?? [] },
    })
    await Promise.allSettled(pendingToolLogWrites)
    await itemSink.flush()
    if (directRun) await store.completeRun(runId, 'completed')
    return { result, run: store.getRun(runId) }
  } catch (error) {
    const message = formatError(error)
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: toolName,
      body: message,
      isError: true,
    })
    if (directRun) {
      const current = store.getRun(runId)
      await store.updateRunState(runId, { errors: [...current.state.errors, message], failedTool: toolName })
      await store.completeRun(runId, 'failed')
    }
    await Promise.allSettled(pendingToolLogWrites)
    await itemSink.flush()
    throw error
  }
}

function logNonBlockingError(scope: string, error: unknown): void {
  console.warn(`[ws:${scope}] ${formatError(error)}`)
}
