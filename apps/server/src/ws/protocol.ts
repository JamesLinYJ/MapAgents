// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面协议
//
//   文件:       protocol.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import { wsControlCommandSchema } from '@geo-agent-platform/shared-types'

export const clientMsgType = wsControlCommandSchema

export const clientMsgSchema = z.object({
  type: clientMsgType,
  id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).prefault({}),
  meta: z.object({
    csrfToken: z.string().min(1).optional(),
  }).strict().optional(),
}).strict()

export type ClientMsg = z.infer<typeof clientMsgSchema>

export function parseMessage(raw: string): ClientMsg {
  return clientMsgSchema.parse(JSON.parse(raw))
}

export function success(id: string, data: unknown): string {
  return format({ type: 'response', id, payload: { ok: true, data } })
}

export function failure(id: string | null, code: string, message: string): string {
  return format({ type: 'response', id, payload: { ok: false, error: { code, message } } })
}

export function push(
  type: 'run.item' | 'run.event' | 'run.snapshot'
    | 'thread.entry' | 'thread.updated' | 'thread.compacted' | 'thread.memory.updated'
    | 'map.scene.updated'
    | 'keepalive',
  data: unknown,
): string {
  return format({ type, id: null, payload: { data } })
}

function format(message: { type: string; id: string | null; payload: Record<string, unknown> }): string {
  return JSON.stringify(message) + '\n'
}
