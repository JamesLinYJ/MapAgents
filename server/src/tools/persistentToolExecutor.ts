// 直接工具调用、Workflow 工具节点共享的持久执行路径。
// 权限与审批由调用方在进入本模块前完成；本模块只负责工具契约、运行历史和结果事实。

import { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult } from '../framework/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { persistToolExecutionResult, resolveRuntimeValueRef } from './resultPersistence.js'
import { resolveRuntimeConfig } from '../ws/runtimeConfig.js'

export interface PersistedToolExecutionInput {
  runId: string
  toolName: string
  args: Record<string, unknown>
  auth: AuthContext
  signal?: AbortSignal
}

export async function executePersistedTool(
  input: PersistedToolExecutionInput,
  deps: {
    store: PlatformPersistenceFacade
    registry: ToolRegistry
    modelRegistry: ModelAdapterRegistry
    defaultRuntimeConfig?: AgentRuntimeConfig | undefined
  },
): Promise<ToolResult> {
  const run = deps.store.getRun(input.runId)
  const values = new Map(run.state.toolValueRefs.map(ref => [ref.refId, ref]))
  const pendingLogWrites: Promise<void>[] = []
  const context: ToolContext = {
    runId: run.id,
    sessionId: run.sessionId,
    threadId: run.threadId,
    signal: input.signal ?? new AbortController().signal,
    runtimeRoot: deps.store.runtimeRoot,
    runtimeConfig: run.runtimeConfigSnapshot ?? await resolveRuntimeConfig(deps.store, deps.defaultRuntimeConfig),
    auth: input.auth,
    state: values,
    resolveValueRef: refId => resolveRuntimeValueRef(values, refId),
    resolveMeteorologicalDataset: datasetInput => deps.store.resolveMeteorologicalDataset({
      sessionId: run.sessionId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      datasetId: datasetInput.datasetId ?? null,
      filename: datasetInput.filename ?? null,
    }),
    invokeStructuredModel: async prompt => {
      const adapter = deps.modelRegistry.resolveProvider(run.modelProvider)
      const response = await adapter.chat(prompt, {
        model: run.modelName ?? adapter.defaultModel,
        reasoning: false,
        signal: context.signal,
      })
      if (typeof response.content !== 'string' || !response.content.trim()) {
        throw new Error('模型未返回结构化内容。')
      }
      const parsed: unknown = JSON.parse(response.content.replace(/^```json\s*|\s*```$/gu, ''))
      if (!isRecord(parsed)) throw new Error('模型结构化输出必须是 JSON object。')
      return parsed
    },
    log: (level, message) => {
      pendingLogWrites.push(deps.store.appendEvent(run.id, {
        eventId: makeId('event'),
        runId: run.id,
        threadId: run.threadId,
        type: 'tool.completed',
        message,
        timestamp: nowUtc(),
        payload: { level, toolName: input.toolName },
      }))
    },
  }

  const callId = makeId('call')
  const tool = deps.registry.get(input.toolName)
  if (!tool) throw new Error(`工具 '${input.toolName}' 未注册`)
  const itemSink = new ItemSink(item => deps.store.appendItem(item), run.id, run.threadId)
  const callItem = itemSink.startItem('function_call', {
    name: input.toolName,
    callId,
    arguments: JSON.stringify(input.args),
    metadata: { toolLabel: tool.label },
  })
  try {
    const result = await deps.registry.execute(input.toolName, input.args, context)
    await persistToolExecutionResult(deps.store, run.id, input.toolName, tool.label, input.args, result)
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: input.toolName,
      output: JSON.stringify(result.payload),
      metadata: { toolLabel: tool.label, resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    const outputItem = itemSink.startItem('function_call_output', {
      callId,
      name: input.toolName,
      role: 'tool',
      metadata: { toolLabel: tool.label, resultId: result.resultId, source: result.source, artifacts: result.artifacts ?? [] },
    })
    itemSink.completeItem(outputItem.itemId, {
      callId,
      name: input.toolName,
      output: JSON.stringify(result.payload),
      metadata: {
        toolLabel: tool.label,
        resultId: result.resultId,
        source: result.source,
        valueRefs: result.valueRefs ?? [],
        artifacts: result.artifacts ?? [],
      },
    })
    await Promise.all(pendingLogWrites)
    await itemSink.flush()
    return result
  } catch (error) {
    itemSink.completeItem(callItem.itemId, {
      callId,
      name: input.toolName,
      body: error instanceof Error ? error.message : '工具执行失败。',
      isError: true,
      metadata: { toolLabel: tool.label },
    })
    await Promise.allSettled(pendingLogWrites)
    await itemSink.flush()
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
