// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 运行命令
//
//   文件:       runCommands.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'

import { optionalPositiveInteger, requiredRunProvider } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import { respondDecision } from './decisionCommand.js'
import { sendRunSnapshot, snapshotRun, subscribeToRun } from './subscriptions.js'
import type { WsCommandRegistry } from './commandRegistry.js'
import type { AuthContext } from '../security/types.js'

const runListPayloadSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const runIdPayloadSchema = z.object({ runId: z.string().min(1) }).passthrough()
const runSteerPayloadSchema = z.object({
  runId: z.string().min(1),
  steeringId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const runStartPayloadSchema = z.object({
  query: z.string().min(1),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelProvider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
  executionMode: z.enum(['auto', 'plan']).optional(),
  reasoning: z.boolean().optional(),
}).passthrough()
const respondDecisionPayloadSchema = z.object({
  runId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  text: z.string().nullable().optional(),
}).passthrough()

export function registerRunCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'run:list',
    payloadSchema: runListPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const limit = optionalPositiveInteger(payload.limit, 'limit')
      return context.dependencies.store.listRunSummaries({
        sessionId: payload.sessionId,
        threadId: payload.threadId ?? null,
        cursor: payload.cursor ?? null,
        ...(limit !== undefined ? { limit } : {}),
      })
    },
  })

  registry.register({
    type: 'run:start',
    payloadSchema: runStartPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const auth = requireAuth(context.auth)
      let threadId = payload.threadId ?? null
      const sessionId = payload.sessionId ?? (threadId ? context.dependencies.store.getThread(threadId).sessionId : null)
      if (!sessionId) throw new Error('sessionId 不能为空')
      context.dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
      if (!threadId) threadId = (await context.dependencies.store.createThread(sessionId, payload.query.slice(0, 32))).id
      const config = await resolveRuntimeConfig(context.dependencies.store, context.dependencies.defaultRuntimeConfig)
      const selectedProvider = payload.provider
        ?? payload.modelProvider
        ?? context.dependencies.modelRegistry.defaultProvider
      if (!selectedProvider) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
      const run = await context.dependencies.store.createRun(sessionId, payload.query, {
        threadId,
        modelProvider: selectedProvider,
        modelName: payload.modelName ?? null,
        runtimeConfigSnapshot: config,
      })
      subscribeToRun(context.ws, run.id, context.dependencies.store, context.subscriptions)
      context.runTasks.startDetached({
        runId: run.id,
        threadId,
        sessionId,
        query: payload.query,
        provider: selectedProvider,
        modelName: run.modelName,
        runtimeConfig: config,
        executionMode: payload.executionMode === 'plan' ? 'plan' : 'auto',
        reasoning: payload.reasoning !== false,
        auth,
      }, { onComplete: runId => sendRunSnapshot(context.ws, runId, context.dependencies.store) })
      return run
    },
  })

  registry.register({
    type: 'run:get',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => snapshotRun(payload.runId, context.dependencies.store),
  })

  registry.register({
    type: 'run:cancel',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.runTasks.cancel(payload.runId),
  })

  registry.register({
    type: 'run:steer',
    payloadSchema: runSteerPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.runTasks.steer(
      payload.runId,
      payload.steeringId,
      payload.content,
    ),
  })

  registry.register({
    type: 'run:resume',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const auth = requireAuth(context.auth)
      const run = context.dependencies.store.getRun(payload.runId)
      const checkpoint = await context.dependencies.store.getRunCheckpoint(payload.runId)
      if (checkpoint.pendingToolCallIds.length) {
        await context.dependencies.store.updateRunStatus(payload.runId, 'requires_action')
        throw new Error(`运行包含状态未知的工具调用，禁止自动重放：${checkpoint.pendingToolCallIds.join(', ')}`)
      }
      if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${payload.runId}' 缺少 runtimeConfigSnapshot`)
      context.dependencies.usageStats.assertWorkspaceCanStartModelRun(auth)
      subscribeToRun(context.ws, payload.runId, context.dependencies.store, context.subscriptions)
      context.runTasks.startDetached({
        runId: payload.runId,
        threadId: run.threadId,
        sessionId: run.sessionId,
        query: run.userQuery,
        provider: requiredRunProvider(run.modelProvider),
        modelName: run.modelName,
        runtimeConfig: run.runtimeConfigSnapshot,
        resume: true,
        auth,
      }, { onComplete: runId => sendRunSnapshot(context.ws, runId, context.dependencies.store) })
      return context.dependencies.store.getRun(payload.runId)
    },
  })

  registry.register({
    type: 'run:respond-decision',
    payloadSchema: respondDecisionPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => respondDecision(
      payload,
      context.dependencies,
      context.runtime,
      context.runTasks,
      context.ws,
      context.subscriptions,
      requireAuth(context.auth),
    ),
  })

  registry.register({
    type: 'run:subscribe',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      subscribeToRun(context.ws, payload.runId, context.dependencies.store, context.subscriptions)
      return snapshotRun(payload.runId, context.dependencies.store)
    },
  })

  registry.register({
    type: 'run:unsubscribe',
    payloadSchema: runIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      context.subscriptions.get(payload.runId)?.()
      context.subscriptions.delete(payload.runId)
      return { unsubscribed: true, runId: payload.runId }
    },
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
