// GeoForge 内置 Workflow 注册表。
// 一个 JSON 文件对应一个完整图定义；加载失败只形成诊断，不阻断其它定义和服务启动。

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { workflowDefinitionSchema, type WorkflowDefinition } from './schemas.js'

export interface WorkflowLoadDiagnostic {
  file: string
  severity: 'warning' | 'error'
  message: string
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly diagnostics: WorkflowLoadDiagnostic[] = []

  register(definition: WorkflowDefinition): void {
    if (this.definitions.has(definition.workflowId)) {
      throw new Error(`Workflow '${definition.workflowId}' 重复注册。`)
    }
    this.definitions.set(definition.workflowId, structuredClone(definition))
  }

  addDiagnostic(diagnostic: WorkflowLoadDiagnostic): void {
    this.diagnostics.push(diagnostic)
  }

  list(): WorkflowDefinition[] {
    return [...this.definitions.values()]
      .map(definition => structuredClone(definition))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  get(workflowId: string): WorkflowDefinition | null {
    const definition = this.definitions.get(workflowId)
    return definition ? structuredClone(definition) : null
  }

  require(workflowId: string): WorkflowDefinition {
    const definition = this.get(workflowId)
    if (!definition) throw new Error(`Workflow '${workflowId}' 不存在。`)
    if (!definition.enabled || definition.lifecycle === 'disabled') {
      throw new Error(`Workflow '${definition.name}' 已禁用。`)
    }
    if (definition.lifecycle !== 'published') {
      throw new Error(`Workflow '${definition.name}' 尚未发布。`)
    }
    return definition
  }

  loadDiagnostics(): WorkflowLoadDiagnostic[] {
    return this.diagnostics.map(diagnostic => ({ ...diagnostic }))
  }
}

export async function createWorkflowRegistryFromDirectory(directoryPath: string): Promise<WorkflowRegistry> {
  const registry = new WorkflowRegistry()
  let entries: string[]
  try {
    entries = await readdir(directoryPath)
  } catch (error) {
    registry.addDiagnostic({
      file: directoryPath,
      severity: 'warning',
      message: `Workflow 目录不可读取：${formatLoadError(error)}`,
    })
    return registry
  }

  for (const entry of entries.filter(name => name.toLowerCase().endsWith('.json')).sort()) {
    const filePath = path.join(directoryPath, entry)
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const definition = workflowDefinitionSchema.parse({
        ...(isRecord(parsed) ? parsed : {}),
        source: 'builtin',
        lifecycle: isRecord(parsed) && parsed.lifecycle === 'disabled' ? 'disabled' : 'published',
        workspaceId: null,
        createdByUserId: null,
      })
      registry.register(definition)
    } catch (error) {
      registry.addDiagnostic({
        file: entry,
        severity: 'error',
        message: `Workflow 定义加载失败：${formatLoadError(error)}`,
      })
    }
  }
  if (!registry.list().length) {
    registry.addDiagnostic({
      file: directoryPath,
      severity: 'warning',
      message: '未加载到任何可用 Workflow。',
    })
  }
  return registry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatLoadError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '未知错误'
}
