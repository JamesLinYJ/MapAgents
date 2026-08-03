// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求遥测测试
//
//   文件:       modelRequestTelemetry.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunStreamEvent } from '@openai/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from './logger.js'
import {
  ModelRequestTelemetry,
  recordModelRequestFailure,
} from './modelRequestTelemetry.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModelRequestTelemetry', () => {
  it('keeps text deltas streaming while emitting one body-free completion summary', () => {
    const info = vi.spyOn(logger, 'info')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(35)
      .mockReturnValueOnce(110)
    const telemetry = new ModelRequestTelemetry({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transport: 'deepseek_responses',
      runId: 'run_1',
      threadId: 'thread_1',
    })

    telemetry.observe(streamEvent({
      type: 'response_started',
      providerData: { response: { id: 'response_1' } },
    }))
    telemetry.observe(streamEvent({ type: 'output_text_delta', delta: '用户可见正文不得进入日志' }))
    expect(info).not.toHaveBeenCalled()
    telemetry.observe(streamEvent({
      type: 'response_done',
      response: {
        id: 'response_1',
        requestId: 'request_1',
        usage: {
          requests: 1,
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          inputTokensDetails: { cached_tokens: 3 },
        },
        output: [],
      },
    }))

    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: 'model.request.completed',
      category: 'model',
      retention: 'operational',
      responseId: 'response_1',
      requestId: 'request_1',
      durationMs: 100,
      timeToFirstTextDeltaMs: 25,
      inputTokens: 12,
      outputTokens: 8,
      cacheHitInputTokens: 3,
    })
    expect(JSON.stringify(info.mock.calls)).not.toContain('用户可见正文不得进入日志')
  })

  it('records only bounded failure classification and correlation identifiers', () => {
    const errorLog = vi.spyOn(logger, 'error')
    const error = Object.assign(new Error('PROMPT_BODY_MUST_NOT_BE_LOGGED'), {
      name: 'APIError',
      code: 'rate_limit_exceeded',
      status: 429,
      request_id: 'request_2',
      response_id: 'response_2',
    })

    recordModelRequestFailure({
      context: { provider: 'deepseek', model: 'deepseek-v4-flash', transport: 'deepseek_responses' },
      responseId: null,
      durationMs: 42,
      error,
    })

    expect(errorLog).toHaveBeenCalledOnce()
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({
      event: 'model.request.failed',
      errorType: 'APIError',
      errorCode: 'rate_limit_exceeded',
      statusCode: 429,
      requestId: 'request_2',
      responseId: 'response_2',
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PROMPT_BODY_MUST_NOT_BE_LOGGED')
  })
})

function streamEvent(data: Record<string, unknown>): RunStreamEvent {
  return { type: 'raw_model_stream_event', data } as unknown as RunStreamEvent
}
