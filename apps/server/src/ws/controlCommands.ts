// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 控制面资源命令
//
//   文件:       controlCommands.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'

import { AzureSpeechService } from '../speech/azureSpeechService.js'
import { agentRuntimeConfigSchema } from '@geo-agent-platform/shared-types/runtime'
import { StoreNotFoundError } from '../store/storeErrors.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const emptyPayloadSchema = z.object({}).passthrough()
const toolCatalogUpsertSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sortOrder: z.number().optional(),
}).passthrough()
const toolCatalogDeleteSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
}).passthrough()
const runtimeConfigUpdateSchema = z.object({
  config: agentRuntimeConfigSchema,
}).passthrough()
const fileDeleteSchema = z.object({
  fileId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
}).passthrough()
const layerListSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).passthrough()
const layerUpdateSchema = z.object({
  layerKey: z.string().min(1),
  update: z.record(z.string(), z.unknown()),
}).passthrough()
const layerDeleteSchema = z.object({
  layerKey: z.string().min(1),
}).passthrough()

export function registerControlCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'tool-catalog:list',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.store.listToolCatalogEntries(),
  })

  registry.register({
    type: 'tool-catalog:upsert',
    payloadSchema: toolCatalogUpsertSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.store.upsertToolCatalogEntry({
      toolKind: payload.toolKind,
      toolName: payload.toolName,
      payload: payload.payload,
      sortOrder: payload.sortOrder ?? 0,
    }),
  })

  registry.register({
    type: 'tool-catalog:delete',
    payloadSchema: toolCatalogDeleteSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      await context.dependencies.store.deleteToolCatalogEntry(payload.toolKind, payload.toolName)
      return { deleted: true }
    },
  })

  registry.register({
    type: 'runtime-config:update',
    payloadSchema: runtimeConfigUpdateSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      await context.dependencies.store.upsertRuntimeConfig('agent-runtime', payload.config)
      return payload.config
    },
  })

  registry.register({
    type: 'speech:authorization',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (_payload, context) => new AzureSpeechService(context.dependencies.env).issueAuthorization(),
  })

  registry.register({
    type: 'file:delete',
    payloadSchema: fileDeleteSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const existing = (await context.files.list(payload.threadId ?? null)).find(file => file.id === payload.fileId)
      const deleted = await context.files.delete(payload.fileId, payload.threadId ?? null)
      if (!deleted) throw new StoreNotFoundError(`文件 '${payload.fileId}' 不存在`)
      if (payload.threadId && existing) {
        await context.dependencies.store.recordAttachment(payload.threadId, existing, 'deleted')
      }
      return { deleted: true, id: payload.fileId }
    },
  })

  registry.register({
    type: 'layer:list',
    payloadSchema: layerListSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => {
      const auth = context.auth
      if (!auth) throw new Error('WebSocket 命令需要登录。')
      return context.dependencies.managedLayers.listVisibleLayers(
        auth.defaultWorkspaceId,
        payload.sessionId ?? null,
        payload.threadId ?? null,
      )
    },
  })

  registry.register({
    type: 'layer:update',
    payloadSchema: layerUpdateSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.managedLayers.updateLayerMetadata(payload.layerKey, payload.update),
  })

  registry.register({
    type: 'layer:delete',
    payloadSchema: layerDeleteSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const deleted = await context.dependencies.managedLayers.deleteLayer(payload.layerKey)
      if (!deleted) throw new StoreNotFoundError(`图层 '${payload.layerKey}' 不存在`)
      return { deleted: true, layerKey: payload.layerKey }
    },
  })
}
