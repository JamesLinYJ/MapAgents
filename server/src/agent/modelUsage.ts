// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Token 用量归一化
//
//   文件:       modelUsage.ts
// --------------------------------------------------------------------------

export interface ModelUsageLike {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | null
}

export interface AggregatedModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitInputTokens: number
  cacheHitReportedCount: number
  responseCount: number
}

const CACHE_HIT_DETAIL_KEYS = new Set([
  'cached_tokens',
  'cachedTokens',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cache_read_tokens',
  'cacheReadTokens',
])

export function aggregateModelUsage(responses: Array<{ usage: ModelUsageLike }>): AggregatedModelUsage {
  return responses.reduce<AggregatedModelUsage>((total, response) => {
    const cacheHit = cacheHitInputTokens(response.usage.inputTokensDetails)
    return {
      inputTokens: total.inputTokens + finiteTokenCount(response.usage.inputTokens),
      outputTokens: total.outputTokens + finiteTokenCount(response.usage.outputTokens),
      totalTokens: total.totalTokens + finiteTokenCount(response.usage.totalTokens),
      cacheHitInputTokens: total.cacheHitInputTokens + cacheHit.value,
      cacheHitReportedCount: total.cacheHitReportedCount + (cacheHit.reported ? 1 : 0),
      responseCount: total.responseCount + 1,
    }
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitInputTokens: 0,
    cacheHitReportedCount: 0,
    responseCount: 0,
  })
}

export function mergeModelUsageStats(
  current: Record<string, number>,
  usage: AggregatedModelUsage,
): Record<string, number> {
  return {
    ...current,
    modelInputTokens: finiteTokenCount(current.modelInputTokens) + usage.inputTokens,
    modelOutputTokens: finiteTokenCount(current.modelOutputTokens) + usage.outputTokens,
    modelCacheHitInputTokens: finiteTokenCount(current.modelCacheHitInputTokens) + usage.cacheHitInputTokens,
    modelCacheHitReportedResponseCount: finiteTokenCount(current.modelCacheHitReportedResponseCount) + usage.cacheHitReportedCount,
    modelTotalTokens: finiteTokenCount(current.modelTotalTokens) + usage.totalTokens,
    modelUsageResponseCount: finiteTokenCount(current.modelUsageResponseCount) + usage.responseCount,
  }
}

function cacheHitInputTokens(
  details: Record<string, number> | Array<Record<string, number>> | null | undefined,
): { value: number; reported: boolean } {
  const records = details ? (Array.isArray(details) ? details : [details]) : []
  let value = 0
  let reported = false
  for (const record of records) {
    const candidates = Object.entries(record)
      .filter(([key]) => CACHE_HIT_DETAIL_KEYS.has(key))
      .map(([, count]) => finiteTokenCount(count))
    if (!candidates.length) continue
    reported = true
    // 同一 provider 可能同时暴露 snake_case 和 camelCase 同义字段；它们
    // 表达同一计数，取最大值可以保留真实值而不重复累计。
    value += Math.max(...candidates)
  }
  return { value, reported }
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}
