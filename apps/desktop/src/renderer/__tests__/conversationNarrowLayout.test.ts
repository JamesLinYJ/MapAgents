// +-------------------------------------------------------------------------
//
//   地理智能平台 - 窄宽对话面板布局守卫
//
//   文件:       conversationNarrowLayout.test.ts
//
//   日期:       2026年08月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const styleRoot = path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles')

describe('窄宽对话面板布局', () => {
  it('按面板宽度而不是 Electron 窗口宽度重排对话内容', async () => {
    const conversationCss = await readFile(path.join(styleRoot, 'conversation.css'), 'utf8')
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(conversationCss).toContain('container-name: conversation-panel;')
    expect(conversationCss).toContain('container-name: conversation-composer;')
    expect(desktopCss).toContain('@container conversation-panel (max-width: 360px)')
    expect(desktopCss).toContain('@container conversation-composer (max-width: 370px)')
  })

  it('停靠式面板不继承整页留白，输入栏使用完整可用宽度', async () => {
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(desktopCss).toMatch(/\.gf-assistant-body \.cc-panel\s*\{[^}]*padding:\s*0;/s)
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-composer\s*\{[^}]*width:\s*calc\(100% - 14px\);/s,
    )
  })

  it('极窄输入栏分行排列操作，不让模式与发送按钮相互覆盖', async () => {
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(desktopCss).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-mode-trigger__label\s*\{\s*display:\s*none;/s,
    )
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-composer-toolbar__secondary\s*\{[^}]*justify-content:\s*flex-end;/s,
    )
  })
})
