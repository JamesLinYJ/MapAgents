// +-------------------------------------------------------------------------
//
//   地理智能平台 - Codex 风格 Agent 运行时基础迁移
//
//   文件:       apply-codex-runtime-foundation.mjs
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const read = relativePath => readFile(path.join(root, relativePath), 'utf8')
const write = (relativePath, content) => writeFile(path.join(root, relativePath), content, 'utf8')

function replaceOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue)
  if (first < 0) throw new Error(`${label}: 未找到预期旧内容`)
  if (source.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`${label}: 预期旧内容出现多次`)
  }
  return `${source.slice(0, first)}${newValue}${source.slice(first + oldValue.length)}`
}

function removeRange(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`${label}: 未找到删除起点`)
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error(`${label}: 未找到删除终点`)
  return `${source.slice(0, start)}${source.slice(end)}`
}

function updateDependency(source, label) {
  const parsed = JSON.parse(source)
  if (!parsed.dependencies || parsed.dependencies['@openai/agents'] === undefined) {
    throw new Error(`${label}: 缺少 @openai/agents 依赖`)
  }
  parsed.dependencies['@openai/agents'] = '0.16.1'
  return `${JSON.stringify(parsed, null, 2)}\n`
}

for (const packagePath of ['package.json', 'apps/server/package.json']) {
  await write(packagePath, updateDependency(await read(packagePath), packagePath))
}

let checkpointService = await read('apps/server/src/agent/agentsCheckpointService.ts')
checkpointService = replaceOnce(
  checkpointService,
  "import type { AgentsExecutionContext } from './agentsToolBridge.js'\n",
  "import type { AgentsExecutionContext } from './agentsToolBridge.js'\nimport { toolCallResultIdsFromHistory } from './agentsSdkStateBoundary.js'\n",
  'agentsCheckpointService import',
)
checkpointService = replaceOnce(
  checkpointService,
  'const terminalToolCallIds = toolCallResultIdsFromSerializedState(serializedState)',
  'const terminalToolCallIds = toolCallResultIdsFromHistory(state.history)',
  'agentsCheckpointService terminal IDs',
)
checkpointService = removeRange(
  checkpointService,
  '/**\n * 只有已进入当前可恢复 RunState 的 function_call_result',
  'export function assertCheckpointCompatibility(',
  'agentsCheckpointService internal parser',
)
await write('apps/server/src/agent/agentsCheckpointService.ts', checkpointService)

await write('apps/server/src/agent/agentsCheckpointService.test.ts', `// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 检查点兼容性测试
//
//   文件:       agentsCheckpointService.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SDK_STATE_SCHEMA_VERSION } from './agentsRuntimeMetadata.js'
import { assertCheckpointCompatibility } from './agentsCheckpointService.js'

const validCheckpoint = {
  orchestrationEngine: 'openai_agents',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentsSdkVersion: '0.16.1',
  runtimeConfigDigest: 'sha256:config',
}

describe('Agents checkpoint compatibility', () => {
  it('接受完全匹配的 SDK 检查点', () => {
    expect(() => assertCheckpointCompatibility(validCheckpoint, {
      runId: 'run_1',
      sdkVersion: '0.16.1',
      configDigest: 'sha256:config',
    })).not.toThrow()
  })

  it.each([
    [{ ...validCheckpoint, orchestrationEngine: null }, '不是 OpenAI Agents SDK 检查点'],
    [{ ...validCheckpoint, sdkStateSchemaVersion: null }, 'SDK 状态 schema 不匹配'],
    [{ ...validCheckpoint, agentsSdkVersion: '0.15.0' }, 'SDK 版本不匹配'],
    [{ ...validCheckpoint, runtimeConfigDigest: 'sha256:other' }, '运行配置已变化'],
  ])('拒绝不兼容检查点', (checkpoint, message) => {
    expect(() => assertCheckpointCompatibility(checkpoint, {
      runId: 'run_1',
      sdkVersion: '0.16.1',
      configDigest: 'sha256:config',
    })).toThrow(message)
  })
})
`)

let sdkExecutor = await read('apps/server/src/agent/runtimeSdkExecutor.ts')
sdkExecutor = replaceOnce(
  sdkExecutor,
  "import { buildInitialAgentInput } from './multimodalInput.js'\n",
  "import { buildInitialAgentInput } from './multimodalInput.js'\nimport { stageRunInputsInSdkState } from './agentsSdkStateBoundary.js'\n",
  'runtimeSdkExecutor boundary import',
)
sdkExecutor = replaceOnce(
  sdkExecutor,
  'appendRunInputsToSdkState(\n',
  'stageRunInputsInSdkState(\n',
  'runtimeSdkExecutor staging call',
)
sdkExecutor = removeRange(
  sdkExecutor,
  '// callModelInputFilter 新增的 item 只影响当次 HTTP 请求',
  'function goalBoundaryReason(',
  'runtimeSdkExecutor local state mutation',
)
await write('apps/server/src/agent/runtimeSdkExecutor.ts', sdkExecutor)

let metadata = await read('apps/server/src/agent/agentsRuntimeMetadata.ts')
metadata = replaceOnce(
  metadata,
  'export const SDK_STATE_SCHEMA_VERSION = AGENTS_SDK_STATE_SCHEMA_VERSION\n',
  "export const SDK_STATE_SCHEMA_VERSION = AGENTS_SDK_STATE_SCHEMA_VERSION\nexport const SUPPORTED_AGENTS_SDK_VERSION = '0.16.1'\n",
  'agentsRuntimeMetadata version constant',
)
metadata = replaceOnce(
  metadata,
  'export function runtimeConfigDigest(config: AgentRuntimeConfig): string {',
  `export function assertAgentsSdkVersionSupported(version: string): void {
  if (version !== SUPPORTED_AGENTS_SDK_VERSION) {
    throw new Error(
      \`不支持的 @openai/agents 版本 '\${version}'；要求 '\${SUPPORTED_AGENTS_SDK_VERSION}'\`,
    )
  }
}

export function runtimeConfigDigest(config: AgentRuntimeConfig): string {`,
  'agentsRuntimeMetadata version assertion',
)
await write('apps/server/src/agent/agentsRuntimeMetadata.ts', metadata)

let assembly = await read('apps/server/src/agent/runtimeAssembly.ts')
assembly = replaceOnce(
  assembly,
  "import { agentsSdkVersion, runtimeConfigDigest } from './agentsRuntimeMetadata.js'",
  "import {\n  agentsSdkVersion,\n  assertAgentsSdkVersionSupported,\n  runtimeConfigDigest,\n} from './agentsRuntimeMetadata.js'",
  'runtimeAssembly metadata import',
)
assembly = replaceOnce(
  assembly,
  "    const selectedModel = options.modelName ?? adapter.defaultModel\n    if (!selectedModel) throw new Error('未配置模型名称')\n",
  "    const selectedModel = options.modelName ?? adapter.defaultModel\n    if (!selectedModel) throw new Error('未配置模型名称')\n    const sdkVersion = await agentsSdkVersion()\n    assertAgentsSdkVersionSupported(sdkVersion)\n",
  'runtimeAssembly version assertion',
)
assembly = replaceOnce(
  assembly,
  '      sdkVersion: await agentsSdkVersion(),',
  '      sdkVersion,',
  'runtimeAssembly version reuse',
)
await write('apps/server/src/agent/runtimeAssembly.ts', assembly)

let standard = await read('AGENTS.md')
standard = replaceOnce(
  standard,
  "- OpenAI Agents SDK `Runner` 是单次 run 内唯一的 Agent 编排状态机。不得在平台层复制 turn loop、handoff loop、工具并发调度或创建并行 Runner\n- SDK `RunState` 是唯一恢复载荷；`AgentState` 只保存平台工作流、审批、UI 和审计投影，不能反向驱动一套重复的 Agent 状态机\n",
  "- 地理智能平台 `RunEngine` 是持久 Run、Turn、Runner segment、输入邮箱、终态竞争和 child Run 生命周期的唯一控制面；这些领域事实写入 PostgreSQL，不从 SDK Session 或 UI 反推\n- OpenAI Agents SDK `Runner` 是单个 Runner segment 内唯一的模型、工具、handoff 与 Agent-as-tool 微循环。平台不得复制原始 Responses/function-call loop\n- 同一 Run 任一时刻最多有一个活动 Runner segment；不同持久 child Run 只能在根控制面的深度、并发和预算限制内并行\n- SDK `RunState` 只保存单个 Runner segment 的公开恢复载荷；`AgentState`/后续 reducer snapshot 保存平台工作流、审批、UI 和审计状态，不得解析 SDK checkpoint 的内部 JSON 布局\n",
  'AGENTS 6.1',
)
standard = replaceOnce(
  standard,
  "- 返回主智能体的子智能体使用 SDK `Agent.asTool()`，转交所有权使用 SDK `handoff()`；不得增加自定义 batch 工具、手动并行 Runner 或第二套工具调度队列\n",
  "- 短小且同步返回父智能体的任务使用 SDK `Agent.asTool()`，同一 Run 内的对话所有权转移使用 SDK `handoff()`；需要独立追问、取消、恢复、预算或并行的长任务使用持久 child Run\n- 同一 Run 禁止并行启动多个 Runner；不同 child Run 的 Runner 由根控制面统一限额，父子通信必须经过持久消息与输入邮箱，不共享可变 RunState\n",
  'AGENTS 6.6',
)
await write('AGENTS.md', standard)

let overview = await read('docs/architecture/overview.md')
overview = replaceOnce(
  overview,
  "1. 用户消息进入 canonical Thread/Run。\n2. `@openai/agents` Runner 是单次运行的编排状态机，RunState 是审批中断和恢复载荷。\n3. 地理智能平台 负责工作流、权限、工具注册、`valueRef`、数据库事实、审计与分层记忆。\n4. DeepSeek 使用专属 OpenAI-compatible Chat Completions Model 适配器；Provider descriptor 限定可选模型和真实能力。\n5. ToolProvider 经过 manifest/schema 一致性校验后才可注册。Python 工具契约以 Pydantic catalog 为事实源。\n6. Desktop Chat 与本机 Agent CLI 都从 `packages/conversation-presentation` 获取消息分类、工具调用配对和公开展示标识；DOM Markdown 与终端 Markdown 只是两个最终渲染目标，不得各自重建业务投影。\n",
  "1. 用户消息进入 canonical Thread/Run 和持久输入邮箱。\n2. 地理智能平台 RunEngine 拥有持久 Run/Turn/Runner segment、目标版本、审批等待、终态竞争和 child Run 生命周期。\n3. `@openai/agents` Runner 只拥有单个 segment 内的模型—工具—handoff 微循环；公开 RunState 是该 segment 的审批中断和恢复载荷。\n4. 地理智能平台 负责工作流、权限、工具注册、`valueRef`、数据库事实、审计与分层记忆；不得解析 SDK checkpoint 的内部 JSON 布局。\n5. DeepSeek 使用专属 OpenAI-compatible Chat Completions Model 适配器；Provider descriptor 限定可选模型和真实能力。\n6. ToolProvider 经过 manifest/schema 一致性校验后才可注册。Python 工具契约以 Pydantic catalog 为事实源。\n7. Desktop Chat 与本机 Agent CLI 都从 `packages/conversation-presentation` 获取消息分类、工具调用配对和公开展示标识；DOM Markdown 与终端 Markdown 只是两个最终渲染目标，不得各自重建业务投影。\n",
  'overview Agent ownership',
)
await write('docs/architecture/overview.md', overview)

let rfc = await read('docs/architecture/codex-agents-sdk-runtime-refactor-plan.md')
rfc = replaceOnce(
  rfc,
  '> **状态**：Proposed',
  '> **状态**：In progress（WP-00、WP-01 与 SDK 防腐基础已进入实现）',
  'RFC status',
)
await write('docs/architecture/codex-agents-sdk-runtime-refactor-plan.md', rfc)

console.log('Codex 风格 Agent 运行时基础迁移已应用。')
