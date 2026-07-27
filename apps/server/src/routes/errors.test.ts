// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 路由错误边界测试
//
//   文件:       errors.test.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { HttpClientError, routeErrorResponse } from './errors.js'
import { logger } from '../observability/logger.js'

describe('routeErrorResponse', () => {
  it('returns explicit client errors without rewriting the message', () => {
    const response = routeErrorResponse(new HttpClientError('上传文件过大，限制为 100MB。', 413), '上传失败。')

    expect(response).toEqual({ detail: '上传文件过大，限制为 100MB。', status: 413 })
  })

  it('does not expose unexpected internal error messages to HTTP clients', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void)
    try {
      const response = routeErrorResponse(
        new Error('duplicate key value violates unique constraint "platform_secret_idx"'),
        'GeoJSON 导入失败。',
      )

      expect(response).toEqual({ detail: 'GeoJSON 导入失败。', status: 400 })
      expect(response.detail).not.toContain('platform_secret_idx')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
