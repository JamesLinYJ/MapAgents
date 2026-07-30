// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志记录契约测试
//
//   文件:       desktopLogRecords.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OperationsLogQuery } from '@geo-agent-platform/shared-types/operations'
import { describe, expect, it } from 'vitest'

import {
  desktopLogMessage,
  projectDesktopLogLines,
  serializeDesktopFileLogRecord,
} from './desktopLogRecords.js'

const baseQuery: OperationsLogQuery = {
  services: ['infra', 'worker', 'api'],
  levels: [],
  streams: [],
  search: '',
  includeSupervisor: true,
  afterSequence: null,
  tail: 2_000,
}

describe('desktop system log records', () => {
  it('projects valid JSONL records and ignores malformed or legacy lines', () => {
    const lines = [
      'legacy text line',
      serializeDesktopFileLogRecord({
        version: 1,
        createdAt: '2026-07-29T09:00:00.000Z',
        level: 'error',
        scope: 'desktop',
        processId: 42,
        message: 'Supervisor 不可用',
      }),
    ]

    expect(projectDesktopLogLines(lines, baseQuery)).toEqual([
      expect.objectContaining({
        sequence: 1_000_000_001,
        serviceId: null,
        component: 'desktop',
        processId: 42,
        level: 'error',
        message: 'Supervisor 不可用',
      }),
    ])
  })

  it('applies supervisor, level, stream, search and tail filters', () => {
    const lines = ['info', 'error'].map((message, index) => serializeDesktopFileLogRecord({
      version: 1,
      createdAt: `2026-07-29T09:00:0${index}.000Z`,
      level: index === 0 ? 'info' : 'error',
      scope: 'desktop',
      processId: 42,
      message,
    }))

    expect(projectDesktopLogLines(lines, {
      ...baseQuery,
      levels: ['error'],
      streams: ['supervisor'],
      search: 'ERROR',
      tail: 1,
    })).toHaveLength(1)
    expect(projectDesktopLogLines(lines, {
      ...baseQuery,
      includeSupervisor: false,
    })).toEqual([])
  })

  it('serializes structured message data without object coercion noise', () => {
    expect(desktopLogMessage(['desktop_ready', { profile: 'development' }]))
      .toBe('desktop_ready {"profile":"development"}')
  })
})
