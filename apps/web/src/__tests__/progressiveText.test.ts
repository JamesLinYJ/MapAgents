// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话逐字显示状态测试
//
//   文件:       progressiveText.test.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  createProgressiveTextState,
  progressiveRevealDelayMs,
  progressiveTextReducer,
  segmentGraphemes,
} from '../features/conversation/progressiveText'

describe('progressive text projection', () => {
  it('reveals exactly one Chinese grapheme per tick', () => {
    const initial = createProgressiveTextState('杭州天气', true)
    const first = progressiveTextReducer(initial, { type: 'reveal_next' })
    const second = progressiveTextReducer(first, { type: 'reveal_next' })

    expect(first.visibleCount).toBe(1)
    expect(first.graphemes.slice(0, first.visibleCount).join('')).toBe('杭')
    expect(second.graphemes.slice(0, second.visibleCount).join('')).toBe('杭州')
  })

  it('keeps emoji and combined characters intact', () => {
    expect(segmentGraphemes('🌧️天气')).toEqual(['🌧️', '天', '气'])
  })

  it('accepts appended server snapshots without jumping the visible prefix', () => {
    let state = createProgressiveTextState('杭州', true)
    state = progressiveTextReducer(state, { type: 'reveal_next' })
    state = progressiveTextReducer(state, { type: 'retarget', target: '杭州今天有雨' })

    expect(state.visibleCount).toBe(1)
    expect(state.animate).toBe(true)
  })

  it('replaces a non-prefix correction immediately to avoid stale text', () => {
    let state = createProgressiveTextState('杭州', true)
    state = progressiveTextReducer(state, { type: 'reveal_next' })
    state = progressiveTextReducer(state, { type: 'retarget', target: '北京' })

    expect(state.visibleCount).toBe(2)
    expect(state.animate).toBe(false)
  })

  it('accelerates a long backlog while still advancing one grapheme per tick', () => {
    expect(progressiveRevealDelayMs(400)).toBeLessThan(progressiveRevealDelayMs(10))
  })
})
