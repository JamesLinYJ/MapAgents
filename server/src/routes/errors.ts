// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 路由错误边界
//
//   文件:       errors.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export class HttpClientError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'HttpClientError'
  }
}

export function routeErrorResponse(error: unknown, publicMessage: string, status = 400): { detail: string; status: number } {
  if (error instanceof HttpClientError) {
    return { detail: error.message, status: error.status }
  }
  console.error(`[api] ${publicMessage}:`, error)
  return { detail: publicMessage, status }
}
