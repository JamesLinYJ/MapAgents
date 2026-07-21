// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维 HTTP 传输层
//
//   文件:       http.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  opsAuditEventSchema,
  opsBootstrapSchema,
  opsStepUpResponseSchema,
  opsTerminalSessionSchema,
  opsTranscriptSummarySchema,
  type OpsBootstrap,
  type OpsTerminalSession,
  type OpsTranscriptSummary,
} from '@geo-agent-platform/shared-types/operations'
import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'

export class OpsHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'OpsHttpError'
  }
}

interface OpsHttpClient {
  bootstrap(): Promise<OpsBootstrap>
  terminals(): Promise<OpsTerminalSession[]>
  transcripts(): Promise<OpsTranscriptSummary[]>
  audit(): Promise<AuditEvent[]>
  stepUp(bootstrap: OpsBootstrap, password: string): Promise<{ verified: true; expiresAt: string }>
  grantTranscriptAccess(bootstrap: OpsBootstrap, terminalId: string, reason: string): Promise<{ grantId: string; expiresAt: string }>
}

export const opsHttp: OpsHttpClient = {
  bootstrap: () => requestJson('/ops/api/v1/bootstrap', value => opsBootstrapSchema.parse(value)),
  terminals: () => requestJson('/ops/api/v1/terminals', value => parseArray(value, opsTerminalSessionSchema.parse)),
  transcripts: () => requestJson('/ops/api/v1/transcripts', value => parseArray(value, opsTranscriptSummarySchema.parse)),
  audit: () => requestJson('/ops/api/v1/audit', value => parseArray(value, opsAuditEventSchema.parse)),
  stepUp: (bootstrap: OpsBootstrap, password: string) => requestJson(
    '/ops/api/v1/step-up',
    value => opsStepUpResponseSchema.parse(value),
    {
      method: 'POST',
      headers: csrfHeaders(bootstrap),
      body: JSON.stringify({ password }),
    },
  ),
  grantTranscriptAccess: (
    bootstrap: OpsBootstrap,
    terminalId: string,
    reason: string,
  ) => requestJson(
    `/ops/api/v1/transcripts/${encodeURIComponent(terminalId)}/access`,
    parseAccessGrant,
    {
      method: 'POST',
      headers: csrfHeaders(bootstrap),
      body: JSON.stringify({ reason }),
    },
  ),
}

async function requestJson<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'include' })
  } catch {
    throw new OpsHttpError(503, '无法连接 Ops Gateway。')
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'detail' in payload
      && typeof (payload as { detail?: unknown }).detail === 'string'
      ? (payload as { detail: string }).detail
      : '运维请求失败。'
    throw new OpsHttpError(response.status, message)
  }
  try {
    return parse(payload)
  } catch {
    throw new OpsHttpError(502, 'Ops Gateway 响应不符合协议。')
  }
}

function csrfHeaders(bootstrap: OpsBootstrap): Headers {
  const headers = new Headers()
  headers.set(bootstrap.csrfHeaderName, bootstrap.csrfToken)
  return headers
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('expected array')
  return value.map(parse)
}

function parseAccessGrant(value: unknown): { grantId: string; expiresAt: string } {
  if (!value || typeof value !== 'object') throw new Error('invalid grant')
  const grantId = 'grantId' in value ? value.grantId : null
  const expiresAt = 'expiresAt' in value ? value.expiresAt : null
  if (typeof grantId !== 'string' || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('invalid grant')
  }
  return { grantId, expiresAt }
}
