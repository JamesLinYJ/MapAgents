// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 本地追踪处理器
//
//   文件:       agentTracing.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  setTraceProcessors,
  setTracingDisabled,
  type Span,
  type SpanData,
  type Trace,
  type TracingProcessor,
} from '@openai/agents'

import type { RunEventSink } from '../agent/turnRunner.js'

// SDK tracing provider 是进程级边界；本类由应用容器显式创建并注入 Runtime，
// 只把无敏感正文的结构化生命周期投影到对应 run 的诊断事件流。
export class LocalAgentTracing implements TracingProcessor {
  private readonly runSinks = new Map<string, RunEventSink>()
  private installed = false

  install(): void {
    if (this.installed) return
    setTraceProcessors([this])
    setTracingDisabled(false)
    this.installed = true
  }

  attachRun(runId: string, sink: RunEventSink): () => void {
    if (!this.installed) throw new Error('Agents SDK 本地追踪处理器尚未安装')
    if (this.runSinks.has(runId)) throw new Error(`运行 '${runId}' 已绑定追踪事件流`)
    this.runSinks.set(runId, sink)
    return () => {
      if (this.runSinks.get(runId) === sink) this.runSinks.delete(runId)
    }
  }

  async onTraceStart(trace: Trace): Promise<void> {
    this.emit(trace.metadata, 'SDK Trace 开始', {
      phase: 'trace_start',
      traceId: trace.traceId,
      traceName: trace.name,
      groupId: trace.groupId,
    })
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    this.emit(trace.metadata, 'SDK Trace 结束', {
      phase: 'trace_end',
      traceId: trace.traceId,
      traceName: trace.name,
      groupId: trace.groupId,
    })
  }

  async onSpanStart(_span: Span<SpanData>): Promise<void> {}

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const summary = summarizeSpan(span.spanData)
    const durationMs = durationBetween(span.startedAt, span.endedAt)
    this.emit(span.traceMetadata, `SDK ${summary.label}${span.error ? '失败' : '完成'}`, {
      phase: 'span_end',
      traceId: span.traceId,
      spanId: span.spanId,
      parentId: span.parentId,
      spanType: span.spanData.type,
      spanName: summary.name,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs,
      failed: span.error !== null,
      ...summary.details,
    })
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.runSinks.values()].map(sink => sink.flush()))
  }

  async shutdown(): Promise<void> {
    if (!this.installed) return
    await this.forceFlush()
    this.runSinks.clear()
    setTracingDisabled(true)
    setTraceProcessors([])
    this.installed = false
  }

  private emit(metadata: unknown, message: string, payload: Record<string, unknown>): void {
    const runId = recordString(metadata, 'runId')
    if (!runId) return
    this.runSinks.get(runId)?.emit('trace.recorded', message, {
      diagnostic: true,
      ...payload,
    })
  }
}

function summarizeSpan(data: SpanData): {
  label: string
  name: string | null
  details: Record<string, unknown>
} {
  switch (data.type) {
    case 'agent':
      return {
        label: 'Agent Span',
        name: data.name,
        details: {
          tools: data.tools ?? [],
          handoffs: data.handoffs ?? [],
          outputType: data.output_type ?? null,
        },
      }
    case 'function':
      return { label: '工具 Span', name: data.name, details: { mcp: Boolean(data.mcp_data) } }
    case 'generation':
      return {
        label: '模型 Span',
        name: data.model ?? null,
        details: {
          inputTokens: data.usage?.input_tokens ?? null,
          outputTokens: data.usage?.output_tokens ?? null,
        },
      }
    case 'response':
      return { label: '响应 Span', name: data.response_id ?? null, details: {} }
    case 'handoff':
      return {
        label: 'Handoff Span',
        name: data.to_agent ?? null,
        details: { fromAgent: data.from_agent ?? null, toAgent: data.to_agent ?? null },
      }
    case 'guardrail':
      return { label: 'Guardrail Span', name: data.name, details: { triggered: data.triggered } }
    case 'mcp_tools':
      return { label: 'MCP 工具发现 Span', name: data.server ?? null, details: { tools: data.result ?? [] } }
    case 'custom':
      return { label: '自定义 Span', name: data.name, details: {} }
    case 'transcription':
      return { label: '转写 Span', name: data.model ?? null, details: { format: data.input.format } }
    case 'speech':
      return { label: '语音 Span', name: data.model ?? null, details: { format: data.output.format } }
    case 'speech_group':
      return { label: '语音组 Span', name: null, details: {} }
  }
}

function durationBetween(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null
  const duration = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function recordString(value: unknown, key: string): string | null {
  if (!isUnknownRecord(value)) return null
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.length ? candidate : null
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
