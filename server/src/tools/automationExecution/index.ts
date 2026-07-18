// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 系统 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }
import type { ToolContext, ToolDef, ToolProvider, ToolResult } from '../../framework/types.js'
import { parseToolManifest } from '../../framework/schema.js'
import type { AutomationInvocationService } from '../../automations/automationInvocationService.js'
import { makeId } from '../../utils/ids.js'
import {
  EXECUTE_AUTOMATION_PROMPT,
  LIST_AUTOMATIONS_PROMPT,
  LIST_AUTOMATION_RUNS_PROMPT,
  READ_AUTOMATION_RUN_PROMPT,
} from './prompts.js'

const toolManifest = parseToolManifest(manifest)

export function createAutomationExecutionProvider(service: AutomationInvocationService): ToolProvider {
  const entries = new Map(toolManifest.tools.map(entry => [entry.name, entry]))
  const definition = (
    name: 'list_automations' | 'list_automation_runs' | 'read_automation_run' | 'execute_automation',
    prompt: string,
    handler: ToolDef['handler'],
  ): ToolDef => {
    const entry = entries.get(name)
    if (!entry) throw new Error(`自动化流程工具清单缺少工具 '${name}'。`)
    const result: ToolDef = {
      ...entry,
      prompt,
      handler,
    }
    if (entry.executionSurfaces) result.executionSurfaces = [...entry.executionSurfaces]
    if (entry.agentResultMode) result.agentResultMode = entry.agentResultMode
    return result
  }
  return {
    manifest: toolManifest,
    tools: () => [
      definition('list_automations', LIST_AUTOMATIONS_PROMPT, async (_args, context) => {
        const auth = requireAuth(context)
        const automations = await service.listAvailable(auth)
        return result('已读取可由智能体调用的自动化流程。', { automations })
      }),
      definition('list_automation_runs', LIST_AUTOMATION_RUNS_PROMPT, async (args, context) => {
        const auth = requireAuth(context)
        const threadId = requireThreadId(context)
        const scope = automationRunScope(args.scope)
        const runs = await service.listAttachedRuns(auth, {
          sessionId: context.sessionId,
          threadId,
          runId: context.runId,
          scope,
        })
        return {
          ...result(scope === 'thread' ? '已读取当前对话的自动化运行记录。' : '已读取当前会话的自动化运行记录。', { scope, runs }),
          valueRefs: runs.map(run => ({
            refId: makeId('ref'),
            kind: 'automation_run',
            label: `${run.automationId} / ${run.automationRunId}`,
            value: {
              automationRunId: run.automationRunId,
              automationId: run.automationId,
              status: run.status,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
            },
          })),
        }
      }),
      definition('read_automation_run', READ_AUTOMATION_RUN_PROMPT, async (args, context) => {
        const auth = requireAuth(context)
        const threadId = requireThreadId(context)
        const automationRunId = automationRunIdFromRef(context, args.automation_run_ref)
        const attached = await service.readAttachedRun(auth, {
          automationRunId,
          sessionId: context.sessionId,
          threadId,
          runId: context.runId,
        })
        const value = {
          ...attached.run,
          artifacts: attached.artifacts,
        }
        return {
          ...result('已读取自动化运行的持久化输出与关联产物。', value),
          valueRefs: [{
            refId: makeId('ref'),
            kind: 'automation_run_output',
            label: `${attached.run.automationId} / ${attached.run.automationRunId} 运行结果`,
            value,
          }],
        }
      }),
      definition('execute_automation', EXECUTE_AUTOMATION_PROMPT, async (args, context) => {
        const auth = requireAuth(context)
        const threadId = requireThreadId(context)
        const executed = await service.executeAttached(auth, {
          automationId: requiredString(args.automation_id, 'automation_id'),
          prompt: requiredString(args.prompt, 'prompt'),
          parameters: isRecord(args.parameters) ? args.parameters : {},
          sessionId: context.sessionId,
          threadId,
          runId: context.runId,
          signal: context.signal,
        })
        return {
          ...result(`自动化流程“${executed.automationId}”执行完成。`, {
            automationRunId: executed.automationRunId,
            automationId: executed.automationId,
            answer: executed.answer,
            outputs: executed.outputs,
          }),
          modelOutput: `${executed.answer}\n\n自动化运行记录：${executed.automationRunId}`,
          valueRefs: [{
            refId: makeId('ref'),
            kind: 'automation_run',
            label: `${executed.automationId} / ${executed.automationRunId}`,
            value: {
              automationRunId: executed.automationRunId,
              automationId: executed.automationId,
            },
          }],
        }
      }),
    ],
  }
}

function automationRunScope(value: unknown): 'thread' | 'session' {
  if (value === undefined || value === 'session') return 'session'
  if (value === 'thread') return 'thread'
  throw new Error('scope 只允许 thread 或 session。')
}

function requireThreadId(context: ToolContext): string {
  if (!context.threadId) throw new Error('当前智能体运行没有 threadId，不能访问会话自动化流程。')
  return context.threadId
}

function automationRunIdFromRef(context: ToolContext, value: unknown): string {
  const refId = requiredString(value, 'automation_run_ref')
  const reference = context.resolveValueRef(refId)
  if (reference.kind !== 'automation_run') {
    throw new Error(`automation_run_ref 必须引用 automation_run，实际为 ${reference.kind}。`)
  }
  const source = isRecord(reference.value) ? reference.value : {}
  return requiredString(source.automationRunId, 'automationRunId')
}

function result(message: string, payload: Record<string, unknown>): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: 'automation',
  }
}

function requireAuth(context: ToolContext) {
  if (!context.auth) throw new Error('执行自动化流程需要登录。')
  return context.auth
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空。`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
