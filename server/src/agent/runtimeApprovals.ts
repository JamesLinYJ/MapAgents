// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 审批决策
//
//   文件:       runtimeApprovals.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 将 SDK approval interruption 转为 GeoForge canonical DecisionRequest。运行时负责
// 发现中断和落盘，本文件只定义审批文案、选项和决策状态合并规则。

import type { DecisionRequest } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'

export function approvalTitle(toolName: string, label?: string): string {
  if (toolName === 'exit_plan_mode') return '接受这个执行计划？'
  return `批准执行：${label ?? toolName}`
}

export function approvalDescription(toolName: string, description?: string): string {
  if (toolName === 'exit_plan_mode') {
    return '计划已准备好。批准后系统会退出只读计划模式，并按这个计划继续执行写入、导出或计算动作。'
  }
  return description ?? `工具 ${toolName} 需要审批`
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
  return {
    decisionId: request.approvalId,
    kind: 'approval',
    title: request.title,
    question: request.title,
    description: request.description,
    options: [
      {
        optionId: 'approve',
        label: request.action === 'exit_plan_mode' ? '批准，开始执行' : '批准执行',
        description: '允许系统继续执行这个动作。',
        kind: 'approval',
        reason: null,
        payload: { approved: true },
      },
      {
        optionId: 'reject',
        label: request.action === 'exit_plan_mode' ? '退回，继续规划' : '拒绝',
        description: '拒绝本次动作，运行会按拒绝结果继续。',
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
