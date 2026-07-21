// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维运行时约束
//
//   文件:       constants.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OpsLimits, OpsServiceId } from '@geo-agent-platform/shared-types/operations'

export const OPS_SERVICE_IDS = ['web', 'api', 'worker', 'infra'] as const satisfies readonly OpsServiceId[]

export const OPS_LIMITS: OpsLimits = {
  terminalsPerAdministrator: 4,
  terminalsPerHost: 16,
  detachTtlSeconds: 30 * 60,
  maximumSessionSeconds: 8 * 60 * 60,
  maximumFrameBytes: 64 * 1024,
  scrollbackLines: 10_000,
  maximumRecordingBytes: 512 * 1024 * 1024,
  transcriptRetentionDays: 7,
  stepUpWindowSeconds: 15 * 60,
}

export const OPS_CHUNK_INTERVAL_MILLISECONDS = 1_000
export const OPS_CHUNK_MAX_PLAINTEXT_BYTES = 256 * 1024
export const OPS_TRANSCRIPT_ACCESS_SECONDS = 5 * 60

export const OPS_SERVICE_METADATA: Record<OpsServiceId, {
  label: string
  description: string
  dependencies: OpsServiceId[]
}> = {
  infra: {
    label: '基础设施',
    description: 'PostGIS、Martin 与 TiTiler',
    dependencies: [],
  },
  worker: {
    label: '计算 Worker',
    description: 'Python 地理与气象计算服务',
    dependencies: ['infra'],
  },
  api: {
    label: '主 API',
    description: 'GeoForge HTTP、WebSocket 与 Agent 运行时',
    dependencies: ['infra', 'worker'],
  },
  web: {
    label: 'Web 工作台',
    description: 'GeoForge 浏览器工作台',
    dependencies: ['api'],
  },
}
