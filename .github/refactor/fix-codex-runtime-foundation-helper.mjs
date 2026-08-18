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
let source = await readFile(helperPath, 'utf8')

source = replaceExactCount(
  source,
  [
    "  'appendRunInputsToSdkState(\\n',",
    "  'stageRunInputsInSdkState(\\n',",
  ].join('\n'),
  [
    "  '                appendRunInputsToSdkState(\\n',",
    "  '                stageRunInputsInSdkState(\\n',",
  ].join('\n'),
  1,
  'runtimeSdkExecutor 调用点迁移规则',
)

source = replaceExactCount(
  source,
  "    if (!selectedModel) throw new Error('未配置模型名称')\\n",
  "    if (!selectedModel) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)\\n",
  2,
  'runtimeAssembly 模型错误契约',
)

await writeFile(helperPath, source, 'utf8')

function replaceExactCount(sourceText, oldValue, newValue, expectedCount, label) {
  const actualCount = sourceText.split(oldValue).length - 1
  if (actualCount !== expectedCount) {
    throw new Error(`${label}: 预期 ${expectedCount} 处，实际 ${actualCount} 处`)
  }
  return sourceText.split(oldValue).join(newValue)
}
