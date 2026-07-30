// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话工具调用渲染测试
//
//   文件:       conversationToolRendering.test.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConversationEntryView } from '../features/conversation/ConversationEntry'

describe('conversation tool rendering', () => {
  it('shows the public tool label and registered identifier explicitly', () => {
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={weatherEntry}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('查询公开天气')
    expect(html).toContain('已调用 · query_public_weather')
  })

  it('does not invent a display identifier for an unregistered tool', () => {
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={{
          ...weatherEntry,
          commands: weatherEntry.commands?.map(command => ({
            ...command,
            title: '工具调用',
            displayIdentifier: null,
          })),
        }}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('工具调用')
    expect(html).not.toContain('query_public_weather')
  })
})

const weatherEntry: ConversationEntry = {
  id: 'tool:call_weather',
  kind: 'command_batch',
  timestamp: '2026-07-27T00:00:00.000Z',
  title: '查询公开天气',
  body: '杭州午后有阵雨。',
  status: 'completed',
  commands: [{
    id: 'call_weather',
    title: '查询公开天气',
    status: 'completed',
    body: '杭州午后有阵雨。',
    toolName: 'query_public_weather',
    displayIdentifier: 'query_public_weather',
    commandText: '{"location":"杭州"}',
    details: {
      args: { location: '杭州' },
      result: { summary: '杭州午后有阵雨。' },
    },
  }],
}
