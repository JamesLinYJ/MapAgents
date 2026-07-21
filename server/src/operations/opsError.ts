// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维边界错误模型
//
//   文件:       opsError.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export type OpsErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'command_failed'

export class OpsError extends Error {
  constructor(
    readonly code: OpsErrorCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
    this.name = 'OpsError'
  }
}

export function toOpsError(error: unknown): OpsError {
  if (error instanceof OpsError) return error
  return new OpsError('command_failed', 503, '运维依赖当前不可用，请查看 Ops Gateway 服务端日志。')
}
