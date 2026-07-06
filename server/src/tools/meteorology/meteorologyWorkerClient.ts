// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象 Worker 客户端
//
//   文件:       meteorologyWorkerClient.ts
//
//   日期:       2026年07月06日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 统一封装气象 Python Worker 的 HTTP 调用、短期签名和响应校验。
// ToolProvider 只关心工具语义，不直接持有 Worker 传输细节。

import { getEnv } from '../../framework/env.js'
import { signWorkerRequest } from './workerAuth.js'

export async function callMeteorologyWorker(name: string, args: Record<string, unknown>) {
  const env = getEnv()
  const url = env.WORKER_URL
  if (!url) throw new Error('WORKER_URL 未配置')
  if (!env.WORKER_SHARED_SECRET) throw new Error('WORKER_SHARED_SECRET 未配置')
  const body = JSON.stringify({ args })
  const response = await fetch(`${url.replace(/\/$/u, '')}/tools/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: signWorkerRequest(env.WORKER_SHARED_SECRET, name, body),
    },
    body,
    signal: AbortSignal.timeout(env.WORKER_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(workerErrorDetail(detail) || `Worker HTTP ${response.status}`)
  }
  const responseBody: unknown = await response.json()
  if (!isRecord(responseBody) || !isRecord(responseBody.payload) || typeof responseBody.message !== 'string') {
    throw new Error(`Worker 工具 "${name}" 返回无效 payload`)
  }
  return { message: responseBody.message, payload: responseBody.payload }
}

function workerErrorDetail(raw: string): string {
  if (!raw.trim()) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // 非 JSON 错误正文原样上浮，避免隐藏 Worker 的真实失败。
  }
  return raw.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
