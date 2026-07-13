// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具与运行时配置控制器
//
//   文件:       toolingController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect, useState } from 'react'
import type {
  AgentRuntimeConfig,
  BackgroundTaskInfo,
  ScheduledTask,
  SystemComponentsStatus,
  TokenUsageSummary,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowRunRecord,
  WorkflowValidationResult,
} from '@geo-agent-platform/shared-types'
import {
  cancelBackgroundTask,
  cancelWorkflow,
  createWorkflow,
  createScheduledTask,
  type ScheduledTaskCreatePayload,
  type ScheduledTaskUpdatePayload,
  deleteToolCatalogEntry,
  getRuntimeConfig,
  getTokenUsageSummary,
  listBackgroundTasks,
  listScheduledTasks,
  listToolCatalogEntries,
  listTools,
  listWorkflows,
  promoteBackgroundTask,
  runTool,
  startWorkflow,
  type StartWorkflowPayload,
  updateScheduledTask,
  updateRuntimeConfig,
  upsertToolCatalogEntry,
  deleteScheduledTask,
  disableWorkflow,
  publishWorkflow,
  respondWorkflowApproval,
  updateWorkflow,
  validateWorkflow,
  type WorkflowDraftPayload,
  type WorkflowUpdatePayload,
} from '../../api/client'
import { getSystemComponents } from '../../api/client'
import { formatUiError } from '../bootstrap'

interface ToolingControllerOptions {
  loadDiagnostics: boolean
  setUiError: (error?: string) => void
}

// 工具控制器持有工具目录、运行时配置和调试状态。
//
// 各事实源独立吸收，单个持久化组件失败不会清空已经成功加载的工具描述。
export function useToolingController({ loadDiagnostics, setUiError }: ToolingControllerOptions) {
  const [availableTools, setAvailableTools] = useState<ToolDescriptor[]>([])
  const [toolCatalogEntries, setToolCatalogEntries] = useState<Array<Record<string, unknown>>>([])
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinition[]>([])
  const [workflowDiagnostics, setWorkflowDiagnostics] = useState<Array<Record<string, unknown>>>([])
  const [workflowValidation, setWorkflowValidation] = useState<Record<string, WorkflowValidationResult>>({})
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunRecord[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskInfo[]>([])
  const [tokenUsageSummary, setTokenUsageSummary] = useState<TokenUsageSummary>()
  const [runtimeConfig, setRuntimeConfig] = useState<AgentRuntimeConfig>()
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isToolSubmitting, setIsToolSubmitting] = useState(false)
  const [isWorkflowSubmitting, setIsWorkflowSubmitting] = useState(false)
  const [isToolCatalogSubmitting, setIsToolCatalogSubmitting] = useState(false)
  const [isRuntimeConfigSubmitting, setIsRuntimeConfigSubmitting] = useState(false)

  const refreshWorkflowState = useCallback(async () => {
    const [workflows, scheduled, background] = await Promise.all([
      listWorkflows(),
      listScheduledTasks(),
      listBackgroundTasks(),
    ])
    setWorkflowDefinitions(workflows.definitions)
    setWorkflowDiagnostics(workflows.diagnostics)
    setWorkflowValidation(workflows.validation)
    setScheduledTasks(scheduled.tasks)
    setWorkflowRuns(scheduled.workflowRuns)
    setBackgroundTasks(background.tasks)
  }, [])

  const refresh = useCallback(async () => {
    const [components, tools, catalogEntries, loadedRuntimeConfig, workflows, scheduled, background, usage] = await Promise.allSettled([
      getSystemComponents(),
      listTools(),
      listToolCatalogEntries(),
      getRuntimeConfig(),
      listWorkflows(),
      listScheduledTasks(),
      listBackgroundTasks(),
      getTokenUsageSummary(),
    ])
    startTransition(() => {
      if (components.status === 'fulfilled') setSystemComponents(components.value)
      if (tools.status === 'fulfilled') setAvailableTools(tools.value ?? [])
      if (catalogEntries.status === 'fulfilled') setToolCatalogEntries(catalogEntries.value ?? [])
      if (loadedRuntimeConfig.status === 'fulfilled') setRuntimeConfig(loadedRuntimeConfig.value)
      if (workflows.status === 'fulfilled') {
        setWorkflowDefinitions(workflows.value.definitions)
        setWorkflowDiagnostics(workflows.value.diagnostics)
        setWorkflowValidation(workflows.value.validation)
      }
      if (scheduled.status === 'fulfilled') {
        setScheduledTasks(scheduled.value.tasks)
        setWorkflowRuns(scheduled.value.workflowRuns)
      }
      if (background.status === 'fulfilled') setBackgroundTasks(background.value.tasks)
      if (usage.status === 'fulfilled') setTokenUsageSummary(usage.value)
    })
    const rejected = [components, tools, catalogEntries, loadedRuntimeConfig, workflows, scheduled, background, usage].find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }, [])

  useEffect(() => {
    // 工具、配置和系统状态只在对应控制面可见时加载，不能占用首页关键路径。
    if (!loadDiagnostics) return
    void refresh().catch(error => setUiError(formatUiError(error, '部分系统状态加载失败。')))
  }, [loadDiagnostics, refresh, setUiError])

  useEffect(() => {
    if (!loadDiagnostics) return
    const timer = window.setInterval(() => {
      void refreshWorkflowState().catch(error => setUiError(formatUiError(error, '工作流状态刷新失败。')))
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [loadDiagnostics, refreshWorkflowState, setUiError])

  const saveRuntimeConfig = useCallback(async (nextConfig: AgentRuntimeConfig) => {
    try {
      setUiError(undefined)
      setIsRuntimeConfigSubmitting(true)
      const saved = await updateRuntimeConfig(nextConfig)
      setRuntimeConfig(saved)
    } catch (error) {
      setUiError(formatUiError(error, '运行时配置保存失败。'))
    } finally {
      setIsRuntimeConfigSubmitting(false)
    }
  }, [setUiError])

  const saveCatalogEntry = useCallback(async (
    tool: ToolDescriptor,
    payload: Record<string, unknown>,
    sortOrder?: number,
  ) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await upsertToolCatalogEntry(tool.toolKind, tool.name, payload, sortOrder)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置保存失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, setUiError])

  const removeCatalogEntry = useCallback(async (tool: ToolDescriptor) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await deleteToolCatalogEntry(tool.toolKind, tool.name)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置删除失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, setUiError])

  const runWorkflow = useCallback(async (payload: StartWorkflowPayload) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await startWorkflow(payload)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 启动失败。'))
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const stopWorkflow = useCallback(async (workflowRunId: string) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await cancelWorkflow(workflowRunId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 取消失败。'))
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const validateWorkflowDraft = useCallback(async (payload: WorkflowDraftPayload) => {
    setUiError(undefined)
    return validateWorkflow(payload)
  }, [setUiError])

  const createWorkflowDraft = useCallback(async (payload: WorkflowDraftPayload) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      const definition = await createWorkflow(payload)
      await refresh()
      return definition
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 草稿创建失败。'))
      throw error
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const updateWorkflowDraft = useCallback(async (payload: WorkflowUpdatePayload) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      const definition = await updateWorkflow(payload)
      await refresh()
      return definition
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 草稿保存失败。'))
      throw error
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const publishWorkflowDraft = useCallback(async (workflowId: string, revision: number) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await publishWorkflow(workflowId, revision)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 发布失败。'))
      throw error
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const disableWorkflowDefinition = useCallback(async (workflowId: string) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await disableWorkflow(workflowId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 停用失败。'))
      throw error
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const respondToWorkflowApproval = useCallback(async (
    workflowRunId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await respondWorkflowApproval(workflowRunId, approvalId, decision)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, 'Workflow 审批响应失败。'))
      throw error
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const saveScheduledTask = useCallback(async (payload: ScheduledTaskCreatePayload | ScheduledTaskUpdatePayload) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      if ('taskId' in payload) {
        await updateScheduledTask(payload)
      } else {
        await createScheduledTask(payload)
      }
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '定时任务保存失败。'))
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const removeScheduledTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await deleteScheduledTask(taskId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '定时任务删除失败。'))
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const stopBackgroundTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      setIsWorkflowSubmitting(true)
      await cancelBackgroundTask(taskId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '后台任务取消失败。'))
    } finally {
      setIsWorkflowSubmitting(false)
    }
  }, [refresh, setUiError])

  const promoteTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      const task = await promoteBackgroundTask(taskId)
      await refresh()
      return task
    } catch (error) {
      setUiError(formatUiError(error, '后台任务定位失败。'))
    }
  }, [refresh, setUiError])

  return {
    availableTools,
    backgroundTasks,
    isToolCatalogSubmitting,
    isRuntimeConfigSubmitting,
    isToolSubmitting,
    isWorkflowSubmitting,
    removeCatalogEntry,
    removeScheduledTask,
    runtimeConfig,
    runTool,
    runWorkflow,
    saveCatalogEntry,
    saveRuntimeConfig,
    saveScheduledTask,
    setIsToolSubmitting,
    setToolRunResult,
    stopBackgroundTask,
    stopWorkflow,
    promoteTask,
    systemComponents,
    scheduledTasks,
    toolCatalogEntries,
    toolRunResult,
    tokenUsageSummary,
    workflowDefinitions,
    workflowDiagnostics,
    workflowValidation,
    workflowRuns,
    validateWorkflowDraft,
    createWorkflowDraft,
    updateWorkflowDraft,
    publishWorkflowDraft,
    disableWorkflowDefinition,
    respondToWorkflowApproval,
  }
}
