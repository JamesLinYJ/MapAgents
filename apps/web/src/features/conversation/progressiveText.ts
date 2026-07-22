// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话逐字显示状态
//
//   文件:       progressiveText.ts
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useEffect, useMemo, useReducer } from 'react'

export interface ProgressiveTextState {
  target: string
  graphemes: string[]
  visibleCount: number
  animate: boolean
}

type ProgressiveTextAction =
  | { type: 'retarget'; target: string }
  | { type: 'reveal_next' }

export function createProgressiveTextState(target: string, animate: boolean): ProgressiveTextState {
  const graphemes = segmentGraphemes(target)
  return {
    target,
    graphemes,
    visibleCount: animate ? 0 : graphemes.length,
    animate,
  }
}

export function progressiveTextReducer(
  state: ProgressiveTextState,
  action: ProgressiveTextAction,
): ProgressiveTextState {
  if (action.type === 'reveal_next') {
    if (!state.animate || state.visibleCount >= state.graphemes.length) return state
    return { ...state, visibleCount: state.visibleCount + 1 }
  }

  if (action.target === state.target) return state
  const graphemes = segmentGraphemes(action.target)
  if (!state.animate) return { target: action.target, graphemes, visibleCount: graphemes.length, animate: false }

  const visibleText = state.graphemes.slice(0, state.visibleCount).join('')
  if (!action.target.startsWith(visibleText)) {
    // 服务端快照发生替换而不是追加时，以权威正文为准，不能继续展示旧前缀。
    return { target: action.target, graphemes, visibleCount: graphemes.length, animate: false }
  }
  return {
    target: action.target,
    graphemes,
    visibleCount: Math.min(state.visibleCount, graphemes.length),
    animate: true,
  }
}

export function progressiveRevealDelayMs(backlog: number): number {
  if (backlog > 320) return 6
  if (backlog > 160) return 8
  if (backlog > 60) return 11
  if (backlog > 20) return 14
  return 18
}

export function segmentGraphemes(text: string): string[] {
  if (!text) return []
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), part => part.segment)
  }
  return Array.from(text)
}

export function useProgressiveText(target: string, animateOnMount: boolean) {
  const [state, dispatch] = useReducer(
    progressiveTextReducer,
    { target, animate: animateOnMount },
    input => createProgressiveTextState(input.target, input.animate),
  )

  useEffect(() => {
    dispatch({ type: 'retarget', target })
  }, [target])

  useEffect(() => {
    if (!state.animate || state.visibleCount >= state.graphemes.length) return
    const backlog = state.graphemes.length - state.visibleCount
    const timer = window.setTimeout(() => dispatch({ type: 'reveal_next' }), progressiveRevealDelayMs(backlog))
    return () => window.clearTimeout(timer)
  }, [state.animate, state.graphemes.length, state.visibleCount])

  const text = useMemo(
    () => state.graphemes.slice(0, state.visibleCount).join(''),
    [state.graphemes, state.visibleCount],
  )
  return {
    text,
    isAnimating: state.animate && state.visibleCount < state.graphemes.length,
  }
}
