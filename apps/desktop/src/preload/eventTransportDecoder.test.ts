// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱桌面事件传输解码器测试
//
//   文件:       eventTransportDecoder.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { encodeDesktopEvent } from '../main/eventTransportEncoder.js'
import { decodeDesktopEvent } from './eventTransportDecoder.js'

describe('sandboxed desktop event transport decoder', () => {
  it('roundtrips a compressed Agent run event', async () => {
    const event = {
      version: 1 as const,
      event: 'transport:push' as const,
      payload: { content: '连续 NC 文件短临分析'.repeat(40_000) },
    }

    expect(await decodeDesktopEvent(encodeDesktopEvent(event))).toEqual(event)
  })
})
