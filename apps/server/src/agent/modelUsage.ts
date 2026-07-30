// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量归一化
//
//   文件:       modelUsage.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
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
  cacheMissInputTokens: number
  cacheMissReportedCount: number
  responseCount: number
}

const CACHE_HIT_DETAIL_KEYS = new Set([
  'cached_tokens',
  'cachedTokens',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cache_read_tokens',
  'cacheReadTokens',
  'prompt_cache_hit_tokens',
])

const CACHE_MISS_DETAIL_KEYS = new Set([
  'prompt_cache_miss_tokens',
  'cache_miss_input_tokens',
  'cacheMissInputTokens',
])

export function aggregateModelUsage(responses: Array<{ usage: ModelUsageLike }>): AggregatedModelUsage {
  return responses.reduce<AggregatedModelUsage>((total, response) => {
    const cacheHit = cacheHitInputTokens(response.usage.inputTokensDetails)
    const cacheMiss = cacheTokenCount(response.usage.inputTokensDetails, CACHE_MISS_DETAIL_KEYS)
    return {
      inputTokens: total.inputTokens + finiteTokenCount(response.usage.inputTokens),
      outputTokens: total.outputTokens + finiteTokenCount(response.usage.outputTokens),
      totalTokens: total.totalTokens + finiteTokenCount(response.usage.totalTokens),
      cacheHitInputTokens: total.cacheHitInputTokens + cacheHit.value,
      cacheHitReportedCount: total.cacheHitReportedCount + (cacheHit.reported ? 1 : 0),
      cacheMissInputTokens: total.cacheMissInputTokens + cacheMiss.value,
      cacheMissReportedCount: total.cacheMissReportedCount + (cacheMiss.reported ? 1 : 0),
      responseCount: total.responseCount + 1,
    }
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitInputTokens: 0,
    cacheHitReportedCount: 0,
    cacheMissInputTokens: 0,
    cacheMissReportedCount: 0,
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
    modelCacheMissInputTokens: finiteTokenCount(current.modelCacheMissInputTokens) + usage.cacheMissInputTokens,
    modelCacheMissReportedResponseCount: finiteTokenCount(current.modelCacheMissReportedResponseCount) + usage.cacheMissReportedCount,
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

function cacheTokenCount(
  details: Record<string, number> | Array<Record<string, number>> | null | undefined,
  keys: ReadonlySet<string>,
): { value: number; reported: boolean } {
  const records = details ? (Array.isArray(details) ? details : [details]) : []
  let value = 0
  let reported = false
  for (const record of records) {
    const candidates = Object.entries(record)
      .filter(([key]) => keys.has(key))
      .map(([, count]) => finiteTokenCount(count))
    if (!candidates.length) continue
    reported = true
    value += Math.max(...candidates)
  }
  return { value, reported }
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}
