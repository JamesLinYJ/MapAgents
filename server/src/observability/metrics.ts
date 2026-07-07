// +-------------------------------------------------------------------------
//
//   地理智能平台 - Prometheus 指标
//
//   文件:       metrics.ts
//
//   日期:       2026年07月07日
//   作者:       Claude Code
// --------------------------------------------------------------------------

// 暴露 /metrics 端点，覆盖 HTTP、WS、工具、Worker、JSONL queue。
// 所有指标带 service=geoforge-api label，避免多服务指标冲突。

import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from 'prom-client'

collectDefaultMetrics({ prefix: 'geoforge_', labels: { service: 'geoforge-api' } })

// HTTP
export const httpRequestsTotal = new Counter({
  name: 'geoforge_http_requests_total',
  help: 'HTTP 请求总数',
  labelNames: ['method', 'path', 'status'],
})

export const httpRequestDurationMs = new Histogram({
  name: 'geoforge_http_request_duration_ms',
  help: 'HTTP 请求耗时 (ms)',
  labelNames: ['method', 'path'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

// WebSocket
export const wsConnectionsActive = new Gauge({
  name: 'geoforge_ws_connections_active',
  help: '活跃 WebSocket 连接数',
})

export const wsMessagesTotal = new Counter({
  name: 'geoforge_ws_messages_total',
  help: 'WebSocket 消息总数',
  labelNames: ['type', 'direction'],
})

// Tools
export const toolExecutionsTotal = new Counter({
  name: 'geoforge_tool_executions_total',
  help: '工具执行总数',
  labelNames: ['tool', 'status', 'language'],
})

export const toolExecutionDurationMs = new Histogram({
  name: 'geoforge_tool_execution_duration_ms',
  help: '工具执行耗时 (ms)',
  labelNames: ['tool', 'language'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 15000, 30000],
})

// Worker
export const workerRequestsTotal = new Counter({
  name: 'geoforge_worker_requests_total',
  help: 'Worker 调用总数',
  labelNames: ['tool', 'status'],
})

export const workerRequestDurationMs = new Histogram({
  name: 'geoforge_worker_request_duration_ms',
  help: 'Worker 调用耗时 (ms)',
  labelNames: ['tool'],
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000],
})

// JSONL storage
export const jsonlQueueDepth = new Gauge({
  name: 'geoforge_jsonl_queue_depth',
  help: 'JSONL 写入队列深度',
  labelNames: ['scope'],
})

export const jsonlFlushLatencyMs = new Histogram({
  name: 'geoforge_jsonl_flush_latency_ms',
  help: 'JSONL flush 延迟 (ms)',
  labelNames: ['scope'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
})

export const jsonlCorruptionTotal = new Counter({
  name: 'geoforge_jsonl_corruption_total',
  help: 'JSONL 损坏行总数',
  labelNames: ['scope'],
})

// Rate limiting
export const rateLimitHitsTotal = new Counter({
  name: 'geoforge_rate_limit_hits_total',
  help: '限速命中总数',
  labelNames: ['scope', 'action'],
})

// Metrics endpoint handler
export async function metricsResponse(): Promise<Response> {
  return new Response(await register.metrics(), {
    headers: { 'Content-Type': register.contentType },
  })
}
