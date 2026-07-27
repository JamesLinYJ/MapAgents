// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 共享协议出口
//
//   文件:       schemas.ts
//
//   日期:       2026年07月13日
//   作者:       jameslinyj, OpenAI Codex
// --------------------------------------------------------------------------

// GeoForge Automation 领域协议只在 shared-types 定义一次。
// 服务端从共享边界导入并在编译器、存储和 WS 层复用，避免执行图与 UI 图漂移。
export {
  backgroundTaskInfoSchema,
  scheduledTaskSchema,
  automationApprovalRequestSchema,
  automationBindingSchema,
  automationDefinitionSchema,
  automationEdgePortSchema,
  automationEdgeSchema,
  automationGraphSchema,
  automationNodeRunSchema,
  automationNodeSchema,
  automationNodeTypeSchema,
  automationRetryPolicySchema,
  automationRunRecordSchema,
  automationValidationIssueSchema,
  automationValidationResultSchema,
  automationVersionRecordSchema,
  type BackgroundTaskInfo,
  type ScheduledTask,
  type AutomationApprovalRequest,
  type AutomationBinding,
  type AutomationDefinition,
  type AutomationEdge,
  type AutomationGraph,
  type AutomationNode,
  type AutomationNodeRun,
  type AutomationNodeType,
  type AutomationRetryPolicy,
  type AutomationRunRecord,
  type AutomationValidationIssue,
  type AutomationValidationResult,
  type AutomationVersionRecord,
} from '@geo-agent-platform/shared-types/resources'

export type AutomationStatus = AutomationRunRecord['status']
export type ScheduledTaskStatus = ScheduledTask['status']
export type AutomationTriggerKind = AutomationRunRecord['triggerKind']

import type {
  ScheduledTask,
  AutomationRunRecord,
} from '@geo-agent-platform/shared-types/resources'
