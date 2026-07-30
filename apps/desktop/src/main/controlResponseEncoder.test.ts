// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面控制响应编码器测试
//
//   文件:       controlResponseEncoder.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  DESKTOP_CONTROL_FRAME_MAX_BYTES,
  desktopControlResponsePayloadSchema,
  desktopControlResponseTransportSchema,
} from '../contracts/desktopIpc.js'
import { encodeDesktopControlResponse } from './controlResponseEncoder.js'

describe('desktop control response encoder', () => {
  it('keeps ordinary responses as direct frames', () => {
    const response = {
      version: 1 as const,
      requestId: crypto.randomUUID(),
      ok: true,
      data: { state: 'ready' },
    }

    expect(encodeDesktopControlResponse(response)).toEqual(response)
  })

  it('compresses repetitive workspace payloads within the 64 KiB frame limit', () => {
    const response = {
      version: 1 as const,
      requestId: crypto.randomUUID(),
      ok: true,
      data: {
        tools: Array.from({ length: 500 }, (_, index) => ({
          name: `meteorology_tool_${index}`,
          description: '用于读取气象数据并返回严格结构化结果。'.repeat(24),
        })),
      },
    }

    const encoded = encodeDesktopControlResponse(response)

    expect(encoded).toMatchObject({ encoding: 'gzip-base64' })
    expect(Buffer.byteLength(JSON.stringify(encoded), 'utf8'))
      .toBeLessThanOrEqual(DESKTOP_CONTROL_FRAME_MAX_BYTES)
    expect(desktopControlResponseTransportSchema.safeParse(encoded).success).toBe(true)
    if (!('encoding' in encoded)) throw new Error('测试载荷未进入压缩传输。')
    const decoded = JSON.parse(gunzipSync(Buffer.from(encoded.payload, 'base64')).toString('utf8'))
    expect(desktopControlResponsePayloadSchema.parse(decoded)).toEqual(response)
  })
})
