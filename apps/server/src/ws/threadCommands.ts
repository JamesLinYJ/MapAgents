// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 线程命令
//
//   文件:       threadCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'

import { optionalPositiveInteger } from './payload.js'
import { subscribeToThread } from './subscriptions.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const sessionPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const threadIdPayloadSchema = z.object({ threadId: z.string().min(1) }).passthrough()
const threadCreatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()
const threadUpdatePayloadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
}).passthrough()
const threadHistoryPayloadSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const threadForkPayloadSchema = z.object({
  threadId: z.string().min(1),
  entryId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()

export function registerThreadCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'thread:list',
    payloadSchema: sessionPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.store.listThreadsForSession(payload.sessionId),
  })

  registry.register({
    type: 'thread:get',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const runs = context.dependencies.store.listRunsForThread(payload.threadId)
      return {
        thread: context.dependencies.store.getThread(payload.threadId),
        manifest: await context.dependencies.store.getThreadManifest(payload.threadId),
        runs,
        latestRun: runs[0] ?? null,
      }
    },
  })

  registry.register({
    type: 'thread:create',
    payloadSchema: threadCreatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.store.createThread(payload.sessionId, payload.title ?? null),
  })

  registry.register({
    type: 'thread:update',
    payloadSchema: threadUpdatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.store.updateThread(payload.threadId, { title: payload.title }),
  })

  registry.register({
    type: 'thread:delete',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      await context.dependencies.store.deleteThread(payload.threadId)
      return { deleted: true, threadId: payload.threadId }
    },
  })

  registry.register({
    type: 'thread:history',
    payloadSchema: threadHistoryPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.store.listThreadHistory(
      payload.threadId,
      payload.cursor ?? null,
      optionalPositiveInteger(payload.limit, 'limit'),
    ),
  })

  registry.register({
    type: 'thread:fork',
    payloadSchema: threadForkPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.store.forkThread(
      payload.threadId,
      payload.entryId,
      payload.title ?? null,
    ),
  })

  registry.register({
    type: 'thread:trash:list',
    payloadSchema: sessionPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.store.listTrash(payload.sessionId),
  })

  registry.register({
    type: 'thread:trash:restore',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.store.restoreThread(payload.threadId),
  })

  registry.register({
    type: 'thread:trash:purge',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      await context.dependencies.store.purgeThread(payload.threadId)
      return { purged: true, threadId: payload.threadId }
    },
  })

  registry.register({
    type: 'thread:subscribe',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      subscribeToThread(context.ws, payload.threadId, context.dependencies.store, context.subscriptions)
      return {
        thread: context.dependencies.store.getThread(payload.threadId),
        manifest: await context.dependencies.store.getThreadManifest(payload.threadId),
      }
    },
  })

  registry.register({
    type: 'thread:unsubscribe',
    payloadSchema: threadIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const key = `thread:${payload.threadId}`
      context.subscriptions.get(key)?.()
      context.subscriptions.delete(key)
      return { unsubscribed: true, threadId: payload.threadId }
    },
  })
}
