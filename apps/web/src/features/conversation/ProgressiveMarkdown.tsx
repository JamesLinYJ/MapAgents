// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话逐字 Markdown
//
//   文件:       ProgressiveMarkdown.tsx
//
//   日期:       2026年07月23日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Markdown } from '../../shared/components/Markdown'
import { useProgressiveText } from './progressiveText'

interface ProgressiveMarkdownProps {
  children: string
  animate: boolean
  reducedMotion: boolean
  sourceStreaming?: boolean
}

export function ProgressiveMarkdown({
  children,
  animate,
  reducedMotion,
  sourceStreaming = false,
}: ProgressiveMarkdownProps) {
  const projection = useProgressiveText(children, animate && !reducedMotion)
  return (
    <Markdown streaming={sourceStreaming || projection.isAnimating}>
      {projection.text}
    </Markdown>
  )
}
