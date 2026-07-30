// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面功能区命令契约测试
//
//   文件:       ribbonCommandContract.test.ts
//
//   日期:       2026年07月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('desktop ribbon command contract', () => {
  it('keeps formerly decorative commands connected to their real owners', async () => {
    const source = await readFile(
      path.resolve('src/renderer/app/layout/WorkspaceLayout.tsx'),
      'utf8',
    )

    expect(source).toContain('label="打开工作区" onClick={onOpenWorkspace}')
    expect(source).toContain('label="任务历史" onClick={onOpenHistory}')
    expect(source).toContain('label="绘制顺序" onClick={onOpenDrawingOrder}')
    expect(source).toContain("label=\"放大\" onClick={() => onMapCommand('zoom-in')}")
    expect(source).toContain("label=\"测量\" onClick={() => onMapCommand('toggle-measure')}")
    expect(source).not.toContain("onSelectSidebar('history')")
  })

  it('does not render a RibbonAction without an explicit click handler', async () => {
    const source = await readFile(
      path.resolve('src/renderer/app/layout/WorkspaceLayout.tsx'),
      'utf8',
    )
    const sourceFile = ts.createSourceFile(
      'WorkspaceLayout.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const actions: ts.JsxSelfClosingElement[] = []
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxSelfClosingElement(node)
        && ts.isIdentifier(node.tagName)
        && node.tagName.text === 'RibbonAction'
      ) {
        actions.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(actions.length).toBeGreaterThan(10)
    for (const action of actions) {
      expect(action.attributes.properties.some(attribute => (
        ts.isJsxAttribute(attribute)
        && attribute.name.getText(sourceFile) === 'onClick'
      ))).toBe(true)
    }
  })
})
