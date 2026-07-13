// GeoForge Workflow Studio、运行、审批、定时任务和后台任务 WS 命令。

import { z } from 'zod'
import { workflowGraphSchema } from '../workflows/schemas.js'
import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

const workflowDraftPayloadSchema = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  parametersSchema: z.record(z.string(), z.unknown()),
  defaultParameters: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().int().positive().max(86_400),
  outputType: z.string().min(1),
  graph: workflowGraphSchema,
}).strict()

const workflowUpdatePayloadSchema = workflowDraftPayloadSchema.extend({
  workflowId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
}).strict()

const workflowIdPayloadSchema = z.object({ workflowId: z.string().min(1) }).strict()
const workflowRevisionPayloadSchema = workflowIdPayloadSchema.extend({ revision: z.number().int().positive() }).strict()

const workflowStartPayloadSchema = z.object({
  workflowId: z.string().min(1),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict()

const workflowRunIdPayloadSchema = z.object({ workflowRunId: z.string().min(1) }).strict()

const workflowApprovalPayloadSchema = workflowRunIdPayloadSchema.extend({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
}).strict()

const scheduledTaskCreatePayloadSchema = z.object({
  targetKind: z.literal('workflow'),
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

export function registerWorkflowCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'workflow:list',
    payloadSchema: z.object({}).strict(),
    auth: 'required',
    csrf: false,
    handler: (_payload, context) => context.dependencies.workflowDefinitionService.list(requireAuth(context.auth)),
  })
  registry.register({
    type: 'workflow:validate',
    payloadSchema: workflowDraftPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.validate(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'workflow:create',
    payloadSchema: workflowDraftPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.create(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'workflow:update',
    payloadSchema: workflowUpdatePayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.saveDraft(
      requireAuth(context.auth),
      payload.workflowId,
      payload.expectedRevision,
      payload,
    ),
  })
  registry.register({
    type: 'workflow:publish',
    payloadSchema: workflowRevisionPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.publish(
      requireAuth(context.auth),
      payload.workflowId,
      payload.revision,
    ),
  })
  registry.register({
    type: 'workflow:disable',
    payloadSchema: workflowIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.disable(requireAuth(context.auth), payload.workflowId),
  })
  registry.register({
    type: 'workflow:history',
    payloadSchema: workflowIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: (payload, context) => context.dependencies.workflowDefinitionService.history(requireAuth(context.auth), payload.workflowId),
  })
  registry.register({
    type: 'workflow:start',
    payloadSchema: workflowStartPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.startWorkflow(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'workflow:cancel',
    payloadSchema: workflowRunIdPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.cancelWorkflow(requireAuth(context.auth), payload.workflowRunId),
  })
  registry.register({
    type: 'workflow:run:get',
    payloadSchema: workflowRunIdPayloadSchema,
    auth: 'required',
    csrf: false,
    handler: async (payload, context) => {
      const run = await context.dependencies.store.getWorkflowRunRecord(payload.workflowRunId)
      if (!run || run.workspaceId !== requireAuth(context.auth).defaultWorkspaceId) throw new Error('Workflow 运行不存在。')
      return run
    },
  })
  registry.register({
    type: 'workflow:respond-approval',
    payloadSchema: workflowApprovalPayloadSchema,
    auth: 'required',
    csrf: true,
    handler: (payload, context) => context.dependencies.scheduledTaskService.respondApproval(
      requireAuth(context.auth),
      payload.workflowRunId,
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
