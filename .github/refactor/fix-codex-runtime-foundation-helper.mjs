// +-------------------------------------------------------------------------
//
//   地理智能平台 - Codex 运行时迁移脚本校正
//
//   文件:       fix-codex-runtime-foundation-helper.mjs
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises'

const helperPath = '.github/refactor/apply-codex-runtime-foundation.mjs'
const oldValue = [
  "  'appendRunInputsToSdkState(\\n',",
  "  'stageRunInputsInSdkState(\\n',",
].join('\n')
const newValue = [
  "  '                appendRunInputsToSdkState(\\n',",
  "  '                stageRunInputsInSdkState(\\n',",
].join('\n')

const source = await readFile(helperPath, 'utf8')
const first = source.indexOf(oldValue)
if (first < 0) throw new Error('未找到 runtimeSdkExecutor 调用点迁移规则')
if (source.indexOf(oldValue, first + oldValue.length) >= 0) {
  throw new Error('runtimeSdkExecutor 调用点迁移规则出现多次')
}
await writeFile(
  helperPath,
  `${source.slice(0, first)}${newValue}${source.slice(first + oldValue.length)}`,
  'utf8',
)
