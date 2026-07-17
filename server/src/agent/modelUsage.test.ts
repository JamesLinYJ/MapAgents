// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量测试
//
//   文件:       modelUsage.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { aggregateModelUsage, mergeModelUsageStats } from './modelUsage.js'

describe('model usage aggregation', () => {
  it('分别累计输入、输出、总量和命中缓存输入', () => {
    const usage = aggregateModelUsage([
      { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokensDetails: { cached_tokens: 40 } } },
      { usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90, inputTokensDetails: { cacheReadInputTokens: 30 } } },
    ])

    expect(usage).toEqual({
      inputTokens: 180,
      outputTokens: 30,
      totalTokens: 210,
      cacheHitInputTokens: 70,
      cacheHitReportedCount: 2,
      responseCount: 2,
    })
  })

  it('同义缓存字段不会被重复累计', () => {
    const usage = aggregateModelUsage([{
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        inputTokensDetails: { cached_tokens: 60, cachedTokens: 60, cache_read_tokens: 60 },
      },
    }])

    expect(usage.cacheHitInputTokens).toBe(60)
    expect(usage.cacheHitReportedCount).toBe(1)
  })

  it('把本次计量合并到已有真实统计', () => {
    const merged = mergeModelUsageStats({ modelInputTokens: 10, customMetric: 3 }, {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cacheHitInputTokens: 4,
      cacheHitReportedCount: 1,
      responseCount: 1,
    })

    expect(merged.modelInputTokens).toBe(15)
    expect(merged.modelOutputTokens).toBe(2)
    expect(merged.modelCacheHitInputTokens).toBe(4)
    expect(merged.modelTotalTokens).toBe(7)
    expect(merged.customMetric).toBe(3)
  })
})
