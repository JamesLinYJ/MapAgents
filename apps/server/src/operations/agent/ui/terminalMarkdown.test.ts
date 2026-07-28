// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 终端 Markdown 适配器测试
//
//   文件:       terminalMarkdown.test.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { renderTerminalMarkdown } from './terminalMarkdown.js'

describe('terminal Markdown adapter', () => {
  it('delegates headings, lists, emphasis, links and fenced code to markdansi', () => {
    const lines = renderTerminalMarkdown([
      '# 杭州天气',
      '',
      '- **结论**：有阵雨，查看[数据源](https://example.com/weather)。',
      '',
      '```ts',
      'const rain = true',
      '```',
    ].join('\n'), 72)
    const text = lines.map(line => line.text).join('\n')

    expect(text).toContain('杭州天气')
    expect(text).toContain('- 结论：有阵雨，查看数据源 (https://example.com/weather)。')
    expect(text).toContain('const rain = true')
    expect(text).not.toContain('**')
    expect(text).not.toContain('```')
    expect(lines.some(line => line.rendered.includes('\u001B['))).toBe(true)
  })

  it('renders GFM tables in a bounded terminal grid', () => {
    const lines = renderTerminalMarkdown([
      '| 地点 | 风险 |',
      '| --- | --- |',
      '| 杭州 | 暴雨 |',
    ].join('\n'), 32)
    const text = lines.map(line => line.text).join('\n')

    expect(text).toContain('┌')
    expect(text).toContain('地点')
    expect(text).toContain('杭州')
    expect(Math.max(...lines.map(line => displayWidth(line.text)))).toBeLessThanOrEqual(32)
  })

  it('removes external terminal control sequences before rendering', () => {
    const [line] = renderTerminalMarkdown('\u001B[31m**安全文本**\u001B[0m', 40)

    expect(line?.text).toBe('安全文本')
    expect(line?.rendered).not.toContain('[31m')
  })
})

function displayWidth(value: string): number {
  let width = 0
  for (const character of value) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(character) ? 2 : 1
  }
  return width
}
