// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 控制命令
//
//   文件:       customProviderCommands.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import { customProviderConfigSchema } from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const emptyPayloadSchema = z.object({}).strict()
const credentialStagePayloadSchema = z.object({
  secret: z.string().min(1).max(8192),
}).strict()
const upsertPayloadSchema = z.object({
  config: customProviderConfigSchema,
  credentialHandle: z.string().min(1).max(200).nullable().optional(),
  clearCredential: z.boolean().default(false),
}).strict().superRefine((payload, context) => {
  if (payload.credentialHandle && payload.clearCredential) {
    context.addIssue({
      code: 'custom',
      path: ['credentialHandle'],
      message: 'credentialHandle 与 clearCredential 不能同时使用',
    })
  }
})
const deletePayloadSchema = z.object({ providerId: z.string().min(1).max(64) }).strict()

export function registerCustomProviderCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'provider:custom:list',
    payloadSchema: emptyPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => requireService(context.dependencies.customProviderService).list(),
  })

  registry.register({
    type: 'provider:credential:stage',
    payloadSchema: credentialStagePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => requireService(context.dependencies.customProviderService)
      .credentials.stage(payload.secret, requireAuth(context.auth)),
  })

  registry.register({
    type: 'provider:custom:upsert',
    payloadSchema: upsertPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => requireService(context.dependencies.customProviderService).save({
      config: payload.config,
      ...(payload.credentialHandle !== undefined ? { credentialHandle: payload.credentialHandle } : {}),
      ...(payload.clearCredential !== undefined ? { clearCredential: payload.clearCredential } : {}),
      auth: requireAuth(context.auth),
    }),
  })

  registry.register({
    type: 'provider:custom:delete',
    payloadSchema: deletePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => ({
      deleted: await requireService(context.dependencies.customProviderService).delete(payload.providerId),
      providerId: payload.providerId,
    }),
  })
}

function requireService<T>(service: T | undefined): T {
  if (!service) throw new Error('自定义 Provider 服务未装配。')
  return service
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
