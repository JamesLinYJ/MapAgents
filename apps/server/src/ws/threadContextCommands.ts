// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 线程上下文命令
//
//   文件:       threadContextCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'

import { assembleThreadContext, compactThreadIfNeeded } from '../agent/contextManager.js'
import { buildSystemPrompt } from '../agent/prompts.js'
import { makeSummarizer } from './modelSelectors.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const threadContextSchema = z.object({
  threadId: z.string().min(1),
}).passthrough()
const threadCompactSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()

export function registerThreadContextCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'thread:context',
    payloadSchema: threadContextSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const config = await resolveRuntimeConfig(context.dependencies.store.runtimeConfiguration, context.dependencies.defaultRuntimeConfig)
      const tools = context.dependencies.toolRegistry
        .list()
        .map(tool => `- ${tool.name}: ${tool.description}`)
        .join('\n')
      const systemPrompt = buildSystemPrompt(config, null, tools, '', '')
      return (await assembleThreadContext(context.dependencies.store, payload.threadId, config.context, systemPrompt)).report
    },
  })

  registry.register({
    type: 'thread:compact',
    payloadSchema: threadCompactSchema,
    auth: 'required',
    csrf: true,
    handler: async (payload, context) => {
      const config = await resolveRuntimeConfig(context.dependencies.store.runtimeConfiguration, context.dependencies.defaultRuntimeConfig)
      return compactThreadIfNeeded(
        context.dependencies.store,
        payload.threadId,
        config.context,
        makeSummarizer(
          context.dependencies.modelRegistry,
          config,
          payload.provider ?? null,
          payload.modelName ?? null,
          context.dependencies.modelCompletions && context.auth?.defaultWorkspaceId
            ? { service: context.dependencies.modelCompletions, workspaceId: context.auth.defaultWorkspaceId }
            : undefined,
        ),
        true,
      )
    },
  })
}
