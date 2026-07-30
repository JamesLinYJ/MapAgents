// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱桌面事件传输解码器
//
//   文件:       eventTransportDecoder.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  desktopEventPayloadSchema,
  desktopEventTransportSchema,
  type DesktopEvent,
} from '../contracts/desktopIpc.js'
import { decodeDesktopCompressedJson } from './compressedIpcPayloadDecoder.js'

export async function decodeDesktopEvent(input: unknown): Promise<DesktopEvent> {
  const envelope = desktopEventTransportSchema.parse(input)
  if (!('encoding' in envelope)) return envelope
  return desktopEventPayloadSchema.parse(
    await decodeDesktopCompressedJson(envelope, '桌面事件'),
  )
}
