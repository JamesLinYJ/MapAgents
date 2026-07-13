// +-------------------------------------------------------------------------
//
//   地理智能平台 - ScheduledWakeUp 系统工具 Provider
//
//   文件:       index.ts
//
// --------------------------------------------------------------------------

import { z } from 'zod'
import manifest from './manifest.json' with { type: 'json' }
import type { ToolDef, ToolProvider, ToolResult } from '../../framework/types.js'
import type { AuthContext } from '../../security/types.js'
import type { ScheduledTaskService } from '../../workflows/scheduledTaskService.js'
import { makeId } from '../../utils/ids.js'

const scheduledWakeUpManifestTool = manifest.tools[0]

const scheduledWakeUpArgsSchema = z.object({
  operation: z.enum(['list', 'create', 'update', 'delete']),
  taskId: z.string().min(1).optional(),
  targetKind: z.enum(['workflow']).optional(),
  targetId: z.string().min(1).optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

export function createScheduledWakeUpProvider(service: ScheduledTaskService): ToolProvider {
  return {
    manifest,
    tools: (): ToolDef[] => [{
      name: 'ScheduledWakeUp',
      label: scheduledWakeUpManifestTool?.label ?? 'ScheduledWakeUp 定时唤醒',
      description: scheduledWakeUpManifestTool?.description ?? '管理系统定时任务。v1 支持将 Workflow 作为定时目标。',
      prompt: [
        '你可以调用 ScheduledWakeUp 管理系统定时任务。',
        '创建或更新任务前必须确认 cron、timezone、目标 workflow 和提示词都明确。',
        '如果用户只是询问已有定时任务，使用 operation=list。',
        '不要承诺任务已经创建，除非工具结果明确返回成功。',
      ].join('\n'),
      group: scheduledWakeUpManifestTool?.group ?? 'system',
      tags: scheduledWakeUpManifestTool?.tags ?? ['scheduler', 'workflow', 'system'],
      isReadOnly: false,
      isDestructive: false,
      requiresApproval: true,
      jsonSchema: scheduledWakeUpManifestTool?.jsonSchema ?? {},
      parameters: scheduledWakeUpArgsSchema,
      handler: async (args, context) => {
        const auth = requireToolAuth(context.auth)
        const parsed = scheduledWakeUpArgsSchema.parse(args)
        if (parsed.operation === 'list') {
          const snapshot = await service.listScheduledTasks(auth)
          return success('已读取定时任务列表。', { tasks: snapshot.tasks, workflowRuns: snapshot.workflowRuns })
        }
        if (parsed.operation === 'create') {
          const task = await service.createScheduledTask(auth, {
            targetKind: parsed.targetKind ?? 'workflow',
            targetId: requireArg(parsed.targetId, 'targetId'),
            title: parsed.title ?? null,
            prompt: requireArg(parsed.prompt, 'prompt'),
            parameters: parsed.parameters ?? {},
            cron: requireArg(parsed.cron, 'cron'),
            timezone: requireArg(parsed.timezone, 'timezone'),
            recurring: parsed.recurring,
            enabled: parsed.enabled,
          })
          return success('定时任务已创建。', { task })
        }
        if (parsed.operation === 'update') {
          const task = await service.updateScheduledTask(auth, requireArg(parsed.taskId, 'taskId'), {
            targetKind: parsed.targetKind,
            targetId: parsed.targetId,
            title: parsed.title,
            prompt: parsed.prompt,
            parameters: parsed.parameters,
            cron: parsed.cron,
            timezone: parsed.timezone,
            recurring: parsed.recurring,
            enabled: parsed.enabled,
          })
          return success('定时任务已更新。', { task })
        }
        const task = await service.deleteScheduledTask(auth, requireArg(parsed.taskId, 'taskId'))
        return success('定时任务已删除。', { task })
      },
    }],
  }
}

function requireToolAuth(auth: AuthContext | null | undefined): AuthContext {
  if (!auth) throw new Error('ScheduledWakeUp 需要登录用户上下文。')
  return auth
}

function requireArg(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`ScheduledWakeUp 缺少参数 ${name}。`)
  return value.trim()
}

function success(message: string, payload: Record<string, unknown>): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: 'ScheduledWakeUp',
  }
}
