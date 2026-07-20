// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流侧栏视图模型
//
//   文件:       WorkspaceWorkflowModel.ts
//
//   日期:       2026年07月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 侧栏只投影服务端工作流或待审批草案，不维护第二份计划状态。

import type { AgentState, AgentWorkflowStep } from '@geo-agent-platform/shared-types'
import { workflowPreviewFromDecision } from '../../features/conversation/useConversation'

export interface WorkspaceWorkflowStepView {
  stepId: string
  title: string
  status: AgentWorkflowStep['status']
  statusLabel: string
  technicalLabel: string
  argsSummary: string | null
  detail: string
}

export interface WorkspaceWorkflowAgentView {
  agentId: string
  name: string
  status: string
  statusLabel: string
  detail: string
}

export interface WorkspaceWorkflowView {
  goal: string
  status: string
  statusLabel: string
  revision: number
  awaitingApproval: boolean
  completedCount: number
  steps: WorkspaceWorkflowStepView[]
  agents: WorkspaceWorkflowAgentView[]
}

export function deriveWorkspaceWorkflowView(agentState?: AgentState | null): WorkspaceWorkflowView | null {
  if (!agentState) return null

  for (const decision of [...agentState.decisions].reverse()) {
    if (decision.status !== 'pending') continue
    const preview = workflowPreviewFromDecision(decision)
    if (!preview) continue
    return {
      goal: preview.goal || '按以下步骤完成当前目标',
      status: 'awaiting_approval',
      statusLabel: '等待审批',
      revision: (agentState.agentWorkflow?.revision ?? 0) + 1,
      awaitingApproval: true,
      completedCount: 0,
      steps: preview.steps.map(step => ({
        stepId: step.stepId,
        title: step.title,
        status: 'pending',
        statusLabel: '待执行',
        technicalLabel: technicalLabel(step.kind, step.toolName, step.ownerAgentId, step.args),
        argsSummary: summarizeArgs(step.args),
        detail: step.reason,
      })),
      agents: projectAgents(agentState),
    }
  }

  const workflow = agentState.agentWorkflow
  if (!workflow) return null
  return {
    goal: workflow.goal,
    status: workflow.status,
    statusLabel: workflowStatusLabel(workflow.status),
    revision: workflow.revision,
    awaitingApproval: workflow.status === 'awaiting_approval',
    completedCount: workflow.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length,
    steps: workflow.steps.map(step => ({
      stepId: step.stepId,
      title: step.title,
      status: step.status,
      statusLabel: workflowStepStatusLabel(step.status),
      technicalLabel: technicalLabel(step.kind, step.toolName, step.ownerAgentId, step.args),
      argsSummary: summarizeArgs(step.args),
      detail: step.errorMessage ?? step.resultSummary ?? step.reason,
    })),
    agents: projectAgents(agentState),
  }
}

function projectAgents(agentState: AgentState): WorkspaceWorkflowAgentView[] {
  return agentState.subAgents
    .filter(agent => agent.stepIds.length > 0 || agent.status !== 'pending')
    .map(agent => ({
      agentId: agent.agentId,
      name: agent.name,
      status: agent.status,
      statusLabel: subAgentStatusLabel(agent.status),
      detail: agent.latestMessage ?? agent.summary,
    }))
}

function technicalLabel(
  kind: string,
  toolName: string,
  ownerAgentId: string,
  args: Record<string, unknown>,
): string {
  if (kind === 'automation' || toolName === 'execute_automation') {
    const automationId = typeof args.automation_id === 'string' ? args.automation_id : null
    return automationId ? `Automation · ${automationId}` : 'Automation'
  }
  if (kind === 'agent' || (ownerAgentId && ownerAgentId !== 'supervisor')) {
    return `Agent · ${ownerAgentId || toolName}`
  }
  return toolName || 'Supervisor'
}

function summarizeArgs(args: Record<string, unknown>): string | null {
  if (!Object.keys(args).length) return null
  return JSON.stringify(args)
}

function workflowStatusLabel(status: string): string {
  if (status === 'awaiting_approval') return '等待审批'
  if (status === 'running') return '执行中'
  if (status === 'adjusting') return '调整中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return status
}

function workflowStepStatusLabel(status: AgentWorkflowStep['status']): string {
  const labels: Record<AgentWorkflowStep['status'], string> = {
    pending: '待执行',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    blocked: '已阻塞',
    skipped: '已跳过',
  }
  return labels[status]
}

function subAgentStatusLabel(status: string): string {
  if (status === 'pending') return '待命'
  if (status === 'running') return '执行中'
  if (status === 'completed') return '已返回'
  if (status === 'failed') return '失败'
  return status
}
