// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation WebSocket 命令
//
//   文件:       automationCommands.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation Studio、运行、审批、定时任务和后台任务 WS 命令。

import { z } from 'zod'
import { automationGraphSchema } from '../automations/schemas.js'
import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const automationDraftPayloadSchema = z.object({
  automationId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  parametersSchema: z.record(z.string(), z.unknown()),
  defaultParameters: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().int().positive().max(86_400),
  outputType: z.string().min(1),
  agentInvocation: z.object({
    enabled: z.boolean(),
    description: z.string(),
    examples: z.array(z.string().min(1)).max(12),
  }).strict().optional(),
  graph: automationGraphSchema,
}).strict()

const automationUpdatePayloadSchema = automationDraftPayloadSchema.extend({
  automationId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
}).strict()

const automationIdPayloadSchema = z.object({ automationId: z.string().min(1) }).strict()
const automationRevisionPayloadSchema = automationIdPayloadSchema.extend({ revision: z.number().int().positive() }).strict()

const automationStartPayloadSchema = z.object({
  automationId: z.string().min(1),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict()

const automationRunIdPayloadSchema = z.object({ automationRunId: z.string().min(1) }).strict()

const automationApprovalPayloadSchema = automationRunIdPayloadSchema.extend({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
}).strict()

const scheduledTaskCreatePayloadSchema = z.object({
  targetKind: z.literal('automation'),
  targetId: z.string().min(1),
  title: z.string().nullable().optional(),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()

const scheduledTaskUpdatePayloadSchema = scheduledTaskCreatePayloadSchema.partial().extend({
  taskId: z.string().min(1),
}).strict()

const taskIdPayloadSchema = z.object({ taskId: z.string().min(1) }).strict()

export function registerAutomationCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'automation:list',
    payloadSchema: z.object({}).strict(),
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.automationDefinitionService.list(requireAuth(context.auth)),
  })
  registry.register({
    type: 'automation:validate',
    payloadSchema: automationDraftPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.automationDefinitionService.validate(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:create',
    payloadSchema: automationDraftPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.automationDefinitionService.create(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:update',
    payloadSchema: automationUpdatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.automationDefinitionService.saveDraft(
      requireAuth(context.auth),
      payload.automationId,
      payload.expectedRevision,
      payload,
    ),
  })
  registry.register({
    type: 'automation:publish',
    payloadSchema: automationRevisionPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.automationDefinitionService.publish(
      requireAuth(context.auth),
      payload.automationId,
      payload.revision,
    ),
  })
  registry.register({
    type: 'automation:disable',
    payloadSchema: automationIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.automationDefinitionService.disable(requireAuth(context.auth), payload.automationId),
  })
  registry.register({
    type: 'automation:history',
    payloadSchema: automationIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.automationDefinitionService.history(requireAuth(context.auth), payload.automationId),
  })
  registry.register({
    type: 'automation:start',
    payloadSchema: automationStartPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.startAutomation(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:cancel',
    payloadSchema: automationRunIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.cancelAutomation(requireAuth(context.auth), payload.automationRunId),
  })
  registry.register({
    type: 'automation:run:get',
    payloadSchema: automationRunIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.scheduledTaskService.getAutomationRun(
      requireAuth(context.auth),
      payload.automationRunId,
    ),
  })
  registry.register({
    type: 'automation:respond-approval',
    payloadSchema: automationApprovalPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.respondApproval(
      requireAuth(context.auth),
      payload.automationRunId,
      payload.approvalId,
      payload.decision,
    ),
  })
  registry.register({
    type: 'scheduled-task:list',
    payloadSchema: z.object({}).strict(),
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.scheduledTaskService.listScheduledTasks(requireAuth(context.auth)),
  })
  registry.register({
    type: 'scheduled-task:create',
    payloadSchema: scheduledTaskCreatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.createScheduledTask(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'scheduled-task:update',
    payloadSchema: scheduledTaskUpdatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.updateScheduledTask(requireAuth(context.auth), payload.taskId, payload),
  })
  registry.register({
    type: 'scheduled-task:delete',
    payloadSchema: taskIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.deleteScheduledTask(requireAuth(context.auth), payload.taskId),
  })
  registry.register({
    type: 'background-task:list',
    payloadSchema: z.object({}).strict(),
    auth: 'required',
    csrf: false,
    handler: async (_payload, context) => ({ tasks: await context.dependencies.scheduledTaskService.listBackgroundTasks(requireAuth(context.auth)) }),
  })
  registry.register({
    type: 'background-task:promote',
    payloadSchema: taskIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.scheduledTaskService.promoteBackgroundTask(requireAuth(context.auth), payload.taskId),
  })
  registry.register({
    type: 'background-task:cancel',
    payloadSchema: taskIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.cancelBackgroundTask(requireAuth(context.auth), payload.taskId),
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}
