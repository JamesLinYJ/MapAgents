// GeoForge Workflow 领域协议只在 shared-types 定义一次。
// 服务端从共享边界导入并在编译器、存储和 WS 层复用，避免执行图与 UI 图漂移。
export {
  backgroundTaskInfoSchema,
  scheduledTaskSchema,
  workflowApprovalRequestSchema,
  workflowBindingSchema,
  workflowDefinitionSchema,
  workflowEdgePortSchema,
  workflowEdgeSchema,
  workflowGraphSchema,
  workflowNodeRunSchema,
  workflowNodeSchema,
  workflowNodeTypeSchema,
  workflowRetryPolicySchema,
  workflowRunRecordSchema,
  workflowValidationIssueSchema,
  workflowValidationResultSchema,
  workflowVersionRecordSchema,
  type BackgroundTaskInfo,
  type ScheduledTask,
  type WorkflowApprovalRequest,
  type WorkflowBinding,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeRun,
  type WorkflowNodeType,
  type WorkflowRetryPolicy,
  type WorkflowRunRecord,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
  type WorkflowVersionRecord,
} from '@geo-agent-platform/shared-types/resources'

export type WorkflowStatus = WorkflowRunRecord['status']
export type ScheduledTaskStatus = ScheduledTask['status']
export type WorkflowTriggerKind = WorkflowRunRecord['triggerKind']

import type {
  ScheduledTask,
  WorkflowRunRecord,
} from '@geo-agent-platform/shared-types/resources'
