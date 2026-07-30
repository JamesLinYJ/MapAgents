// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 发送边界测试
//
//   文件:       subscriptions.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { sendWs } from './subscriptions.js'

describe('sendWs transport boundary', () => {
  it('terminates one failed connection when the send callback reports an error', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_message: string, callback: (error?: Error) => void) => {
        callback(new Error('socket write failed'))
      }),
      terminate,
    } as unknown as WebSocket

    expect(() => sendWs(ws, '{}\n')).not.toThrow()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('contains synchronous send failures', () => {
    const terminate = vi.fn()
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => {
        throw new Error('socket already closed')
      }),
      terminate,
    } as unknown as WebSocket

    expect(() => sendWs(ws, '{}\n')).not.toThrow()
    expect(terminate).toHaveBeenCalledOnce()
  })
})
