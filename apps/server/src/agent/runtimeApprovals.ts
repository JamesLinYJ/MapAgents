// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 审批决策
//
//   文件:       runtimeApprovals.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 将 SDK approval interruption 转为统一 DecisionRequest。运行时负责
// 发现中断和落盘，本文件只定义审批文案、选项和决策状态合并规则。

import type { DecisionRequest } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'

export function approvalTitle(toolName: string, label?: string): string {
  if (toolName === 'submit_agent_workflow') return '批准这个智能体工作流？'
  if (toolName === 'revise_agent_workflow') return '批准这次工作流修订？'
  return `批准执行：${label ?? toolName}`
}

export function approvalDescription(toolName: string, description?: string): string {
  if (toolName === 'submit_agent_workflow') {
    return '工作流已经规划完成。批准后将在同一运行中按步骤依赖继续执行；中途仍可引导和调整。'
  }
  if (toolName === 'revise_agent_workflow') {
    return '执行路径因新证据、失败或用户引导发生变化。批准后才会采用下方修订步骤；此前批准不自动覆盖新路径。'
  }
  return description ?? `工具 ${toolName} 需要审批`
}

export function approvalRejectionMessage(toolName: string): string {
  if (toolName === 'submit_agent_workflow' || toolName === 'revise_agent_workflow') {
    return '用户退回了这份工作流，且没有提供原因。不要先调用其它发现或业务工具，也不要提出绕过 Automation、审批、权限或真实数据边界的路径；请立即调用 request_clarification 询问需要修改的方向。'
  }
  return '用户拒绝执行该工具。不要重试同一个动作；没有拒绝原因时请请求澄清。'
}

export function approvalDecisionFromRequest(request: {
  approvalId: string
  action: string
  title: string
  description: string
  status: string
  payload: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}): DecisionRequest {
  const workflowApproval = request.action === 'submit_agent_workflow' || request.action === 'revise_agent_workflow'
  return {
    decisionId: request.approvalId,
    kind: 'approval',
    title: request.title,
    question: request.title,
    description: request.description,
    options: [
      {
        optionId: 'approve',
        label: request.action === 'submit_agent_workflow'
          ? '批准，开始执行'
          : request.action === 'revise_agent_workflow'
            ? '批准修订，继续执行'
            : '批准执行',
        description: '允许系统继续执行这个动作。',
        kind: 'approval',
        reason: null,
        payload: { approved: true },
      },
      {
        optionId: 'reject',
        label: workflowApproval ? '退回工作流' : '拒绝',
        description: workflowApproval
          ? '不采用这份工作流，运行会按拒绝结果继续。'
          : '拒绝本次动作，运行会按拒绝结果继续。',
        kind: 'approval',
        reason: null,
        payload: { approved: false },
      },
    ],
    allowFreeText: false,
    status: request.status,
    payload: {
      ...request.payload,
      approvalId: request.approvalId,
      action: request.action,
    },
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  }
}

export function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  return [...decisions.filter(item => item.decisionId !== decision.decisionId), decision]
}

export function resolveDecision(
  decisions: DecisionRequest[],
  decisionId: string,
  status: string,
  payload: Record<string, unknown>,
): DecisionRequest[] {
  const resolvedAt = nowUtc()
  return decisions.map(decision => decision.decisionId === decisionId
    ? { ...decision, status, resolvedAt, payload: { ...decision.payload, ...payload } }
    : decision)
}
