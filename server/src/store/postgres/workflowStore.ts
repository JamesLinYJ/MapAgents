// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Workflow 持久化门面
//
//   文件:       workflowStore.ts
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type {
  ScheduledTask,
  WorkflowDefinition,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from '../../workflows/schemas.js'
import {
  ScheduledTaskRepository,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
} from './scheduledTaskRepository.js'
import { WorkflowDefinitionRepository } from './workflowDefinitionRepository.js'
import {
  WorkflowRunRepository,
  type CreateWorkflowRunInput,
  type UpdateWorkflowRunInput,
} from './workflowRunRepository.js'

export type {
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from './scheduledTaskRepository.js'
export type {
  CreateWorkflowRunInput,
  UpdateWorkflowRunInput,
} from './workflowRunRepository.js'

/**
 * 保留面向平台服务的稳定组合接口；资源写入分别由定义、调度和运行仓储负责。
 * 门面不持有数据库连接，也不跨资源实现事务。
 */
export class WorkflowStore {
  private readonly definitions: WorkflowDefinitionRepository
  private readonly schedules: ScheduledTaskRepository
  private readonly runs: WorkflowRunRepository

  constructor(db: Database) {
    this.definitions = new WorkflowDefinitionRepository(db)
    this.schedules = new ScheduledTaskRepository(db)
    this.runs = new WorkflowRunRepository(db)
  }

  syncDefinitions(definitions: WorkflowDefinition[]): Promise<void> {
    return this.definitions.syncDefinitions(definitions)
  }

  listDefinitions(workspaceId: string): Promise<WorkflowDefinition[]> {
    return this.definitions.listDefinitions(workspaceId)
  }

  getDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
    return this.definitions.getDefinition(workflowId)
  }

  getDefinitionVersion(workflowId: string, revision: number): Promise<WorkflowDefinition | null> {
    return this.definitions.getDefinitionVersion(workflowId, revision)
  }

  getPublishedDefinition(workflowId: string): Promise<WorkflowDefinition | null> {
    return this.definitions.getPublishedDefinition(workflowId)
  }

  listDefinitionVersions(workflowId: string): Promise<WorkflowVersionRecord[]> {
    return this.definitions.listDefinitionVersions(workflowId)
  }

  createDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    return this.definitions.createDefinition(definition)
  }

  saveDefinitionRevision(
    definition: WorkflowDefinition,
    expectedRevision: number,
  ): Promise<WorkflowDefinition> {
    return this.definitions.saveDefinitionRevision(definition, expectedRevision)
  }

  publishDefinition(workflowId: string, revision: number): Promise<WorkflowDefinition> {
    return this.definitions.publishDefinition(workflowId, revision)
  }

  disableDefinition(workflowId: string): Promise<WorkflowDefinition> {
    return this.definitions.disableDefinition(workflowId)
  }

  listScheduledTasks(workspaceId: string): Promise<ScheduledTask[]> {
    return this.schedules.listScheduledTasks(workspaceId)
  }

  listActiveScheduledTasks(): Promise<ScheduledTask[]> {
    return this.schedules.listActiveScheduledTasks()
  }

  getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
    return this.schedules.getScheduledTask(taskId)
  }

  createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    return this.schedules.createScheduledTask(input)
  }

  updateScheduledTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    return this.schedules.updateScheduledTask(taskId, input)
  }

  markScheduledTaskDeleted(taskId: string): Promise<ScheduledTask> {
    return this.schedules.markScheduledTaskDeleted(taskId)
  }

  createWorkflowRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.runs.createWorkflowRun(input)
  }

  getWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord | null> {
    return this.runs.getWorkflowRun(workflowRunId)
  }

  updateWorkflowRun(
    workflowRunId: string,
    input: UpdateWorkflowRunInput,
  ): Promise<WorkflowRunRecord> {
    return this.runs.updateWorkflowRun(workflowRunId, input)
  }

  listWorkflowRuns(
    workspaceId: string,
    scheduledTaskId?: string | null,
  ): Promise<WorkflowRunRecord[]> {
    return this.runs.listWorkflowRuns(workspaceId, scheduledTaskId)
  }
}
