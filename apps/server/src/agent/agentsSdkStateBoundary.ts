// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 状态防腐边界
//
//   文件:       agentsSdkStateBoundary.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { AgentInputItem } from '@openai/agents'

/**
 * Agents SDK 0.16.1 仍未提供在一次活动 Runner 的 callModelInputFilter 中，
 * 把刚租赁的 steering 同时写回当前 RunState 的公开 API。该兼容接口把唯一
 * 受控的 SDK 内部字段接触收口在本文件；业务模块不得直接访问该字段。
 *
 * 后续 RunEngine/Runner segment 迁移完成后，应以 RunState.addInput() 在
 * segment 边界接纳输入，并删除本接口。
 */
export interface AgentsSdkSerializableInputState {
  _originalInput: string | AgentInputItem[]
}

export function stageRunInputsInSdkState(
  state: AgentsSdkSerializableInputState,
  runId: string,
  items: readonly AgentInputItem[],
): void {
  const original = typeof state._originalInput === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: state._originalInput }]
    : [...state._originalInput]
  const existing = new Map<number, AgentInputItem>()

  for (const item of original) {
    const marker = runInputMarker(item)
    if (!marker) continue
    if (marker.runId !== runId) {
      throw new Error(`RunState 含有其它运行 '${marker.runId}' 的 input marker`)
    }
    bindInputSequence(existing, marker.inputSequence, item, runId)
  }

  for (const item of items) {
    const marker = runInputMarker(item)
    if (!marker || marker.runId !== runId) {
      throw new Error(`运行 '${runId}' 的 leased input 缺少可序列化 marker`)
    }
    const previous = existing.get(marker.inputSequence)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(item)) {
        throw new Error(`运行 '${runId}' 的 input sequence ${marker.inputSequence} 内容不一致`)
      }
      continue
    }
    const copy = structuredClone(item)
    original.push(copy)
    existing.set(marker.inputSequence, copy)
  }

  state._originalInput = original
}

/**
 * RunState.history 是 SDK 的公开、模型可见历史视图。恢复账本只从这个公开
 * 视图中的 function_call_result 关闭 callId，不解析 opaque checkpoint JSON。
 */
export function toolCallResultIdsFromHistory(
  history: readonly AgentInputItem[],
): string[] {
  const callIds = new Set<string>()
  for (const item of history) {
    if (item.type !== 'function_call_result') continue
    if (typeof item.callId === 'string' && item.callId) callIds.add(item.callId)
  }
  return [...callIds]
}

function bindInputSequence(
  existing: Map<number, AgentInputItem>,
  inputSequence: number,
  item: AgentInputItem,
  runId: string,
): void {
  const previous = existing.get(inputSequence)
  if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
    throw new Error(`运行 '${runId}' 的 input sequence ${inputSequence} 内容不一致`)
  }
  existing.set(inputSequence, item)
}

function runInputMarker(item: AgentInputItem): {
  runId: string
  inputSequence: number
} | null {
  if (!('providerData' in item) || !item.providerData) return null
  const marker = item.providerData.geoAgentRunInput
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const runId = Reflect.get(marker, 'runId')
  const inputSequence = Reflect.get(marker, 'inputSequence')
  return typeof runId === 'string'
    && Number.isInteger(inputSequence)
    && (inputSequence as number) > 0
    ? { runId, inputSequence: inputSequence as number }
    : null
}
