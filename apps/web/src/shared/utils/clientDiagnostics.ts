// +-------------------------------------------------------------------------
//
//   地理智能平台 - 浏览器端诊断日志
//
//   文件:       clientDiagnostics.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export type ClientDiagnosticLevel = 'warn' | 'error'

export interface ClientDiagnosticPayload {
  scope: string
  error?: unknown
  detail?: unknown
}

// 浏览器端没有服务端 pino 上下文，但仍需要集中脱敏和统一出口。
// 生产错误上报服务接入时，只替换本模块，不让组件散落 console 调用。
export function reportClientDiagnostic(level: ClientDiagnosticLevel, payload: ClientDiagnosticPayload): void {
  const sanitized = sanitizeClientDiagnostic(payload)
  if (level === 'error') {
    console.error('[地理智能工作台]', sanitized)
    return
  }
  console.warn('[地理智能工作台]', sanitized)
}

export function sanitizeClientDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MaxDepth]'
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || value === undefined) return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeClientDiagnostic(item, depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      output[key] = shouldRedactKey(key) ? '[REDACTED]' : sanitizeClientDiagnostic(entry, depth + 1)
    }
    return output
  }
  return value
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('csrf')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
}

function sanitizeString(value: string): string {
  return value
    .replace(/file:\/\/\/?[^\s'"<>),]+/giu, '[LOCAL_PATH]')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)\/[^\s'"<>),]+/gu, '$1[LOCAL_PATH]')
}
