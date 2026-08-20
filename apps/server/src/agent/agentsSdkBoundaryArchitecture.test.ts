// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 防腐边界架构守卫
//
//   文件:       agentsSdkBoundaryArchitecture.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Agents SDK anti-corruption boundary', () => {
  it('把 SDK 内部状态接触限制在单一防腐文件，并禁止解析 checkpoint 内部布局', async () => {
    const sourceRoot = path.join(process.cwd(), 'src')
    const files = await collectProductionTypescript(sourceRoot)
    const internalInputToken = '.' + '_' + 'originalInput'
    const generatedItemsToken = 'generated' + 'Items'
    const allowedInternalInputFile = 'agent/agentsSdkStateBoundary.ts'

    for (const file of files) {
      const relative = path.relative(sourceRoot, file).replace(/\\/gu, '/')
      const source = await readFile(file, 'utf8')
      if (source.includes(internalInputToken)) {
        expect(relative).toBe(allowedInternalInputFile)
      }
      expect(source.includes(generatedItemsToken), relative).toBe(false)
      expect(
        /JSON\.parse\([^)]*\.toString\(\)/u.test(source),
        relative,
      ).toBe(false)
    }
  })
})

async function collectProductionTypescript(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      output.push(...await collectProductionTypescript(absolute))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    output.push(absolute)
  }
  return output
}
