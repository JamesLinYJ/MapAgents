// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry（语言无关）
//
//   文件:       registry.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { ToolDef, ToolProvider, ToolContext, ToolResult } from './types.js'
import { validateToolProvider } from './validation.js'
import { ensureToolSchemas, schemaParameters, isRecord } from './schema.js'
import { logger } from '../observability/logger.js'
import { artifactDisplaySchema } from '../schemas/types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private providers = new Map<string, ToolProvider>()
  private unavailableProviders = new Map<string, string>()

  register(provider: ToolProvider): void {
    validateToolProvider(provider)
    if (this.providers.has(provider.manifest.id)) {
      throw new Error(`Provider "${provider.manifest.id}" 重复注册`)
    }
    for (const tool of provider.tools()) {
      ensureToolSchemas(tool)
      if (this.tools.has(tool.name)) throw new Error(`工具 "${tool.name}" 重复注册`)
      tool.providerId = provider.manifest.id
      tool.language = provider.manifest.language
      this.tools.set(tool.name, tool)
    }
    this.providers.set(provider.manifest.id, provider)
    this.unavailableProviders.delete(provider.manifest.id)
    logger.info({ providerId: provider.manifest.id, language: provider.manifest.language, toolCount: provider.tools().length }, 'provider registered')
  }

  markUnavailable(providerId: string, reason: string): void {
    this.unavailableProviders.set(providerId, reason)
  }

  unregister(providerId: string): void {
    const provider = this.providers.get(providerId)
    if (!provider) return
    for (const tool of provider.tools()) {
      this.tools.delete(tool.name)
    }
    this.providers.delete(providerId)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  listProviders(): ToolProvider[] {
    return [...this.providers.values()]
  }

  providerStatuses() {
    const enabled = this.listProviders().map(provider => ({
      providerId: provider.manifest.id,
      name: provider.manifest.name,
      version: provider.manifest.version,
      author: provider.manifest.author,
      language: provider.manifest.language,
      toolCount: provider.manifest.tools.length,
      available: true,
      error: null,
    }))
    const unavailable = [...this.unavailableProviders].map(([providerId, error]) => ({
      providerId,
      name: providerId,
      version: null,
      author: null,
      language: null,
      toolCount: 0,
      available: false,
      error,
    }))
    return [...enabled, ...unavailable]
  }

  validatePlannedArguments(name: string, args: Record<string, unknown>): string | null {
    const tool = this.tools.get(name)
    if (!tool) return `工具 "${name}" 未注册`
    const result = ensureToolSchemas(tool).parameters.partial().safeParse(args)
    if (result.success) return null
    return result.error.issues.map(issue => formatIssue(issue)).join('；')
  }

  descriptors() {
    return this.list().map(t => ({
      name: t.name,
      label: t.label,
      description: t.description,
      group: t.group,
      toolKind: 'provider',
      providerId: t.providerId ?? null,
      language: t.language ?? null,
      isReadOnly: t.isReadOnly,
      isDestructive: t.isDestructive,
      available: true,
      tags: t.tags,
      parameters: schemaParameters(ensureToolSchemas(t).jsonSchema),
      error: null,
      meta: {
        providerId: t.providerId,
        language: t.language,
        isReadOnly: t.isReadOnly,
        isDestructive: t.isDestructive,
        approvalRecommended: t.isDestructive || t.requiresApproval === true,
        executionSurfaces: t.executionSurfaces ?? ['agent', 'automation', 'debug'],
        agentResultMode: t.agentResultMode ?? 'continue',
        planModeAccess: t.planModeAccess ?? 'blocked',
        jsonSchema: ensureToolSchemas(t).jsonSchema,
      },
    }))
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`工具 "${name}" 未注册`)
    const validatedArgs = validateArguments(tool, args)

    ctx.log('info', `执行 ${tool.label} (${tool.providerId})`)
    const result = await tool.handler(validatedArgs, ctx)
    if (!result.resultId || !result.source || !result.message || !isRecord(result.payload)) {
      throw new Error(`工具 "${name}" 返回了无效结果`)
    }
    if (tool.agentResultMode === 'return_direct' && !result.modelOutput?.trim()) {
      throw new Error(`工具 "${name}" 声明直接返回，但没有提供 modelOutput`)
    }
    for (const artifact of result.artifacts ?? []) {
      if (!artifact.artifactId || !artifact.artifactType || !artifact.name || !artifact.uri || !artifact.relativePath) {
        throw new Error(`工具 "${name}" 返回了无效 artifact`)
      }
      const display = artifactDisplaySchema.safeParse(artifact.display)
      if (!display.success) {
        throw new Error(`工具 "${name}" 的 artifact "${artifact.artifactId}" 展示契约无效：${display.error.issues[0]?.message ?? '未知 schema 错误'}`)
      }
    }
    return result
  }
}

function validateArguments(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const result = ensureToolSchemas(tool).parameters.safeParse(args)
  if (!result.success) {
    const details = result.error.issues.map(issue => formatIssue(issue)).join('；')
    throw new Error(`工具 "${tool.name}" 参数无效：${details}`)
  }
  return result.data as Record<string, unknown>
}

function formatIssue(issue: unknown): string {
  const record = isRecord(issue) ? issue : {}
  const path = Array.isArray(record.path) ? record.path.map(String).join('.') || '参数' : '参数'
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.message === 'string' ? record.message : '参数不合法'
  const keys = Array.isArray(record.keys) ? record.keys.map(String) : []
  if (code === 'unrecognized_keys' && keys.length) return `${path}: 未知参数 "${keys.join('、')}"`
  if (code === 'too_big' && typeof record.maximum !== 'undefined') return `${path}: 不能大于 ${String(record.maximum)}`
  if (code === 'too_small' && typeof record.minimum !== 'undefined') return `${path}: 不能小于 ${String(record.minimum)}`
  if (code === 'invalid_type' && record.expected === 'array') return `${path}: 必须是数组`
  if (code === 'invalid_type' && record.expected === 'object') return `${path}: 必须是对象`
  if (code === 'invalid_type' && record.expected === 'string') return `${path}: 必须是字符串`
  if (code === 'invalid_type' && record.expected === 'number') return `${path}: 必须是数字`
  return `${path}: ${message}`
}

