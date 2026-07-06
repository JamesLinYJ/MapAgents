// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 实时订阅
//
//   文件:       subscriptions.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 运行和线程事件的实时推送集中在这里。事实源仍是 store 的 JSONL/runtime
// 总线；WebSocket 只负责把已持久化或已发布的事件转成协议消息。

import { WebSocket } from 'ws'

import type { PostgresPlatformStore } from '../store/platformStore.js'
import { push } from './protocol.js'

export function subscribeToRun(
  ws: WebSocket,
  runId: string,
  store: PostgresPlatformStore,
  subscriptions: Map<string, () => void>,
): void {
  store.getRun(runId)
  if (subscriptions.has(runId)) return
  const unsubscribeItem = store.itemBus.subscribe(runId, item => sendWs(ws, push('run.item', item)))
  const unsubscribeEvent = store.eventBus.subscribe(runId, event => sendWs(ws, push('run.event', event)))
  const unsubscribeRun = store.runBus.subscribe(runId, () => void sendRunSnapshot(ws, runId, store))
  subscriptions.set(runId, () => {
    unsubscribeItem()
    unsubscribeEvent()
    unsubscribeRun()
  })
}

export function subscribeToThread(
  ws: WebSocket,
  threadId: string,
  store: PostgresPlatformStore,
  subscriptions: Map<string, () => void>,
): void {
  store.getThread(threadId)
  const key = `thread:${threadId}`
  if (subscriptions.has(key)) return
  const unsubscribeEntry = store.threadEntryBus.subscribe(threadId, entry => sendWs(ws, push('thread.entry', entry)))
  const unsubscribeUpdate = store.threadUpdateBus.subscribe(threadId, update => sendWs(ws, push('thread.updated', update)))
  const unsubscribeCompact = store.threadCompactionBus.subscribe(threadId, record => sendWs(ws, push('thread.compacted', record)))
  const unsubscribeMemory = store.threadMemoryBus.subscribe(threadId, memory => sendWs(ws, push('thread.memory.updated', memory)))
  subscriptions.set(key, () => {
    unsubscribeEntry()
    unsubscribeUpdate()
    unsubscribeCompact()
    unsubscribeMemory()
  })
}

export async function snapshotRun(runId: string, store: PostgresPlatformStore) {
  const [items, events] = await Promise.all([store.listItems(runId), store.listEvents(runId)])
  return { run: store.getRun(runId), items, events }
}

export async function sendRunSnapshot(ws: WebSocket, runId: string, store: PostgresPlatformStore): Promise<void> {
  sendWs(ws, push('run.snapshot', await snapshotRun(runId, store)))
}

export function sendWs(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(message)
}
