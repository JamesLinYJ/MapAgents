// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 最终输出守卫
//
//   文件:       runtimeOutputGuardrails.ts
//
//   日期:       2026年07月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  OutputGuardrailTripwireTriggered,
  type OutputGuardrail,
} from '@openai/agents'
import { supervisorDeliverySchema } from '@geo-agent-platform/shared-types/runtime'
import type { AgentsExecutionContext } from './agentsToolBridge.js'

const PLAN_MODE_TERMINAL_GUARDRAIL = 'plan_mode_terminal_contract'
const PLAN_MODE_TERMINAL_ERROR = '计划模式不能以普通正文结束；必须请求澄清或提交结构化智能体工作流。'

interface PlanModeTerminalGuardrailOptions {
  hasTerminalViolation(): boolean
}

// 动态进入计划模式意味着本轮已经声明了待规划目标。模型若未通过正式控制工具
// 收口，SDK 必须拒绝这个最终输出，避免把“仍在规划”投影成“已完成”。
export function createPlanModeTerminalGuardrail(
  options: PlanModeTerminalGuardrailOptions,
): OutputGuardrail<typeof supervisorDeliverySchema, AgentsExecutionContext> {
  return {
    name: PLAN_MODE_TERMINAL_GUARDRAIL,
    async execute() {
      const violation = options.hasTerminalViolation()
      return {
        tripwireTriggered: violation,
        outputInfo: violation
          ? { code: PLAN_MODE_TERMINAL_GUARDRAIL, message: PLAN_MODE_TERMINAL_ERROR }
          : { code: 'ok' },
      }
    },
  }
}

export function planModeTerminalGuardrailMessage(error: unknown): string | null {
  if (!(error instanceof OutputGuardrailTripwireTriggered)) return null
  const outputInfo: unknown = error.result.output.outputInfo
  if (!isRecord(outputInfo) || outputInfo.code !== PLAN_MODE_TERMINAL_GUARDRAIL) return null
  return typeof outputInfo.message === 'string' && outputInfo.message.trim()
    ? outputInfo.message.trim()
    : PLAN_MODE_TERMINAL_ERROR
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
