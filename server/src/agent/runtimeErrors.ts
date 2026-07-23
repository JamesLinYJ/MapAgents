// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 稳定错误映射
//
//   文件:       runtimeErrors.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  ToolTimeoutError,
  UserError,
} from '@openai/agents'

export function runtimeFailureMessage(error: unknown): string {
  if (error instanceof MaxTurnsExceededError) {
    return '智能体已达到最大运行轮次，为避免循环调用已停止。'
  }
  if (error instanceof ToolTimeoutError) {
    return '工具执行超时，运行已停止；请检查依赖服务后重试。'
  }
  if (error instanceof ModelBehaviorError) {
    return '模型返回了不符合 Agent 协议的内容，运行已停止。'
  }
  if (error instanceof UserError) {
    return stableChineseMessage(
      error.message,
      'Agents SDK 拒绝了当前运行配置或恢复状态；请查看服务端日志。',
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return '运行已取消。'
  }
  if (error instanceof Error && /sandbox|manifest|backend|session state/iu.test(error.message)) {
    return stableChineseMessage(error.message, 'Sandbox 创建或恢复失败；请检查后端配置和服务日志。')
  }
  if (error instanceof Error) {
    return stableChineseMessage(error.message, '服务处理失败。请查看服务端日志。')
  }
  return '服务处理失败。请查看服务端日志。'
}

function stableChineseMessage(message: string, fallback: string): string {
  const normalized = message.trim()
  if (!normalized) return fallback
  return /[\u3400-\u9fff]/u.test(normalized) ? normalized : fallback
}
