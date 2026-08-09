// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制命令
//
//   文件:       subAgentCommands.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { SubAgentState } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const runPayloadSchema = z.object({ runId: z.string().min(1) }).strict()
const identityPayloadSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
}).strict()
const followUpPayloadSchema = identityPayloadSchema.extend({
  followUpId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const cancelPayloadSchema = identityPayloadSchema.extend({
  cancellationId: z.string().min(1).max(160),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict()

export function registerSubAgentCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'subagent:list',
    payloadSchema: runPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => ({
      items: context.dependencies.store.getRun(payload.runId).state.subAgents,
    }),
  })

  registry.register({
    type: 'subagent:get',
    payloadSchema: identityPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const run = context.dependencies.store.getRun(payload.runId)
      const agent = requireSubAgent(run.state.subAgents, payload.agentId)
      const events = (await context.dependencies.store.listEvents(payload.runId))
        .filter(event => event.payload.agentId === payload.agentId || event.payload.fromAgentId === payload.agentId)
      return { agent, events }
    },
  })

  registry.register({
    type: 'subagent:follow-up',
    payloadSchema: followUpPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.runtime.followUpSubAgent({
      runId: payload.runId,
      agentId: payload.agentId,
      controlId: payload.followUpId,
      content: payload.content,
      createdByUserId: requireAuth(context.auth).userId,
    }),
  })

  registry.register({
    type: 'subagent:cancel',
    payloadSchema: cancelPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.runtime.cancelSubAgent({
      runId: payload.runId,
      agentId: payload.agentId,
      controlId: payload.cancellationId,
      content: payload.reason ?? '用户取消了子智能体任务。',
      createdByUserId: requireAuth(context.auth).userId,
    }),
  })
}

function requireSubAgent(subAgents: SubAgentState[], agentId: string): SubAgentState {
  const agent = subAgents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new Error(`子 Agent '${agentId}' 不存在。`)
  return agent
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
