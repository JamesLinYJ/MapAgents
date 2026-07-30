// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 实时订阅
//
//   文件:       subscriptions.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 运行和线程事件的实时推送集中在这里。事实源仍是 PostgreSQL 仓储与
// 应用事件总线；WebSocket 只负责把已持久化或已发布的事件转成协议消息。

import { WebSocket } from 'ws'

import type {
  AnalysisRun,
  ConversationItem,
  RunEvent,
} from '../schemas/types.js'
import type { PlatformEventHub } from '../store/platformEventHub.js'
import { push } from './protocol.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import {
  projectConversationItemForTransport,
  projectRunEventForTransport,
  projectRunSnapshotForTransport,
} from './runTransportProjection.js'

export interface RunSubscriptionStore {
  getRun(runId: string): AnalysisRun
  getThread(threadId: string): unknown
  listItems(runId: string): Promise<ConversationItem[]>
  listEvents(runId: string): Promise<RunEvent[]>
}

export function subscribeToRun(
  ws: WebSocket,
  runId: string,
  store: RunSubscriptionStore,
  events: PlatformEventHub,
  subscriptions: Map<string, () => void>,
): void {
  store.getRun(runId)
  if (subscriptions.has(runId)) return
  const unsubscribeItem = events.conversationItems.subscribe(
    runId,
    item => sendWs(ws, push('run.item', projectConversationItemForTransport(item))),
  )
  const unsubscribeEvent = events.runEvents.subscribe(
    runId,
    event => sendWs(ws, push('run.event', projectRunEventForTransport(event))),
  )
  const unsubscribeRun = events.runs.subscribe(runId, () => void sendRunSnapshot(ws, runId, store))
  subscriptions.set(runId, () => {
    unsubscribeItem()
    unsubscribeEvent()
    unsubscribeRun()
  })
}

export function subscribeToThread(
  ws: WebSocket,
  threadId: string,
  store: RunSubscriptionStore,
  events: PlatformEventHub,
  subscriptions: Map<string, () => void>,
): void {
  store.getThread(threadId)
  const key = `thread:${threadId}`
  if (subscriptions.has(key)) return
  const unsubscribeEntry = events.threadEntries.subscribe(threadId, entry => sendWs(ws, push('thread.entry', entry)))
  const unsubscribeUpdate = events.threadUpdates.subscribe(threadId, update => sendWs(ws, push('thread.updated', update)))
  const unsubscribeCompact = events.threadCompactions.subscribe(threadId, record => sendWs(ws, push('thread.compacted', record)))
  const unsubscribeMemory = events.threadMemories.subscribe(threadId, memory => sendWs(ws, push('thread.memory.updated', memory)))
  const unsubscribeMapScene = events.mapScenes.subscribe(threadId, scene => sendWs(ws, push('map.scene.updated', scene)))
  subscriptions.set(key, () => {
    unsubscribeEntry()
    unsubscribeUpdate()
    unsubscribeCompact()
    unsubscribeMemory()
    unsubscribeMapScene()
  })
}

export async function snapshotRun(runId: string, store: RunSubscriptionStore) {
  const [items, events] = await Promise.all([store.listItems(runId), store.listEvents(runId)])
  return projectRunSnapshotForTransport({ run: store.getRun(runId), items, events })
}

export async function sendRunSnapshot(ws: WebSocket, runId: string, store: RunSubscriptionStore): Promise<void> {
  sendWs(ws, push('run.snapshot', await snapshotRun(runId, store)))
}

export function sendWs(ws: WebSocket, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(message, error => {
      if (!error) return
      logger.warn({ error: errorLogPayload(error) }, 'ws send failed')
      terminateConnection(ws)
    })
  } catch (error) {
    logger.warn({ error: errorLogPayload(error) }, 'ws send failed synchronously')
    terminateConnection(ws)
  }
}

function terminateConnection(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
}
