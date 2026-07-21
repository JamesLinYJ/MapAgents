// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维显示格式
//
//   文件:       format.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OpsServiceState } from '@geo-agent-platform/shared-types/operations'

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1_024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let current = value / 1_024
  let unit = units[0] ?? 'KiB'
  for (const candidate of units.slice(1)) {
    if (current < 1_024) break
    current /= 1_024
    unit = candidate
  }
  return `${current.toFixed(current >= 100 ? 0 : 1)} ${unit}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor(total % 86_400 / 3_600)
  const minutes = Math.floor(total % 3_600 / 60)
  if (days) return `${days}天 ${hours}小时`
  if (hours) return `${hours}小时 ${minutes}分`
  if (minutes) return `${minutes}分`
  return `${total}秒`
}

export function serviceStateLabel(state: OpsServiceState): string {
  return ({
    disabled: '已禁用',
    pending: '等待中',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    completed: '已结束',
    failed: '失败',
    unknown: '未知',
  } satisfies Record<OpsServiceState, string>)[state]
}
