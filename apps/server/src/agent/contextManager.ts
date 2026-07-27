// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连续对话上下文管理器
//
//   文件:       contextManager.ts
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type {
  AgentRuntimeConfig,
  CompactionRecord,
  ContentRef,
  ContextAssemblyReport,
  ThreadMemoryDocument,
  TranscriptEntry,
} from '../schemas/types.js'
import type { ThreadContextStore } from '../store/runtimePorts.js'
import type { VisibleArtifactResource } from '../store/postgres/artifactRepository.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { RuntimeFileStore } from '../store/fileStore.js'

const USER_NOTES_START = '<!-- user-notes:start -->'
const USER_NOTES_END = '<!-- user-notes:end -->'

const THREAD_MEMORY_TEMPLATE = `# 会话标题
_用 5-10 个词概括本线程。_

# 当前状态
_正在做什么、还没完成什么、下一步是什么。_

# 任务规格
_用户要求、关键设计决定和约束。_

# 文件、数据与工具
_重要文件、数据集、图层、artifact、valueRef、工具或函数，以及为什么相关。_

# 自动化流程
_常用命令、工具链、运行顺序和输出解释。_

# 错误与修正
_遇到的错误、用户纠正、失败路径和不要重复的方法。_

# 系统文档
_平台组件、运行边界和上下文规则。_

# 学习记录
_有效做法、无效做法和应避免的行为。_

# 关键结果
_用户请求的具体结果、表格、结论或产物引用。_

# 工作日志
_按时间记录已尝试和已完成事项，保持简洁。_
`

export interface ConversationChatMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface AssembledThreadContext {
  messages: ConversationChatMessage[]
  report: ContextAssemblyReport
  memory: ThreadMemoryDocument
}

export type ContextSummarizer = (prompt: string) => Promise<string>

export interface ThreadContextAssemblyOptions {
  excludeRunId?: string
  artifactResources?: readonly VisibleArtifactResource[]
}

// assembleThreadContext
//
// 只使用 canonical transcript 活动父链；run event、reasoning 和 UI progress 永不进入模型。
export async function assembleThreadContext(
  store: ThreadContextStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  systemPrompt: string,
  options: ThreadContextAssemblyOptions = {},
): Promise<AssembledThreadContext> {
  const [rawChain, manifest, memory] = await Promise.all([
    store.activeTranscript(threadId),
    store.getThreadManifest(threadId),
    store.getThreadMemory(threadId),
  ])
  const chain = await hydrateContentReferences(store, rawChain)
  const latestSummaryIndex = findLastIndex(chain, entry => entry.kind === 'compact_summary')
  const visibleChain = latestSummaryIndex >= 0 ? chain.slice(latestSummaryIndex) : chain
  const resourceMessage = await buildThreadResourceMessage(
    store,
    threadId,
    visibleChain,
    options.artifactResources ?? [],
    options.excludeRunId,
  )
  const historyChain = options.excludeRunId
    ? visibleChain.filter(entry => entry.runId !== options.excludeRunId)
    : visibleChain
  let transcriptMessages = transcriptEntriesToChatMessages(historyChain)
  let includedEntries = historyChain.filter(isModelVisibleEntry)

  const baseTokens = estimateTokens(systemPrompt) + estimateTokens(memory.content)
  const hardBudget = Math.floor(config.contextWindowTokens * config.hardLimitRatio)
  if (baseTokens + estimateMessages(transcriptMessages) > hardBudget) {
    const trimmed = preserveRecentTurns(historyChain, config.preserveRecentTurns)
    transcriptMessages = transcriptEntriesToChatMessages(trimmed)
    includedEntries = trimmed.filter(isModelVisibleEntry)
  }

  const memoryMessages: ConversationChatMessage[] = memory.content.trim()
    ? [{ role: 'system', content: `<thread-memory>\n${memory.content}\n</thread-memory>` }]
    : []
  const messages: ConversationChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...memoryMessages,
    ...(resourceMessage ? [{ role: 'system', content: resourceMessage }] : []),
    ...transcriptMessages,
  ]
  const systemTokens = estimateTokens(systemPrompt)
  const memoryTokens = estimateTokens(memory.content)
  const resourceTokens = resourceMessage
    ? estimateMessages([{ role: 'system', content: resourceMessage }])
    : 0
  const transcriptTokens = Math.max(0, estimateMessages(transcriptMessages) - resourceTokens)
  const estimatedTokens = systemTokens + memoryTokens + transcriptTokens + resourceTokens
  const usageRatio = estimatedTokens / config.contextWindowTokens
  const includedIds = new Set(includedEntries.map(entry => entry.entryId))
  const report: ContextAssemblyReport = {
    threadId,
    activeLeafEntryId: manifest.activeLeafEntryId,
    contextWindowTokens: config.contextWindowTokens,
    estimatedTokens,
    usageRatio,
    compactionRecommended: usageRatio >= config.compactRatio,
    hardLimitReached: usageRatio >= config.hardLimitRatio,
    includedEntryIds: [...includedIds],
    omittedEntryCount: historyChain.filter(isModelVisibleEntry).filter(entry => !includedIds.has(entry.entryId)).length,
    latestCompactionId: manifest.latestCompactionId,
    sections: [
      { name: 'system', estimatedTokens: systemTokens },
      { name: 'memory', estimatedTokens: memoryTokens },
      { name: 'transcript', estimatedTokens: transcriptTokens },
      { name: 'resources', estimatedTokens: resourceTokens },
    ],
  }
  return { messages, report, memory }
}

// compactThreadIfNeeded
//
// 压缩只追加 boundary/summary 和最近 turn 的重放副本；原始 transcript 永不改写或删除。
export async function compactThreadIfNeeded(
  store: ThreadContextStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  summarize: ContextSummarizer,
  force = false,
): Promise<CompactionRecord | null> {
  const [manifest, chain] = await Promise.all([
    store.getThreadManifest(threadId),
    store.activeTranscript(threadId),
  ])
  const ratio = manifest.estimatedContextTokens / config.contextWindowTokens
  if (!force && ratio < config.compactRatio) return null

  const visible = stripCompactionReplay(chain)
  const preserveIndex = findPreserveStart(visible, config.preserveRecentTurns)
  if (preserveIndex <= 0) return null
  const compacted = visible.slice(0, preserveIndex)
  const preserved = visible.slice(preserveIndex)
  if (!compacted.some(entry => entry.kind === 'message')) return null
  const firstCompacted = compacted[0]
  if (!firstCompacted) return null

  const summaryPrompt = buildCompactionPrompt(compacted)
  const summary = (await summarize(summaryPrompt)).trim()
  if (!summary) throw new Error('摘要模型返回空内容')
  const strategy: CompactionRecord['strategy'] = 'model'

  const compactionId = makeId('compact')
  const boundary = await store.appendTranscript({
    threadId,
    kind: 'compact_boundary',
    payload: {
      compactionId,
      firstCompactedEntryId: firstCompacted.entryId,
      lastCompactedEntryId: compacted.at(-1)?.entryId,
      preservedFromEntryId: preserved[0]?.entryId ?? null,
    },
  })
  const summaryEntry = await store.appendTranscript({
    threadId,
    kind: 'compact_summary',
    parentEntryId: boundary.entryId,
    payload: { compactionId, content: summary, strategy },
  })

  let parentEntryId = summaryEntry.entryId
  for (const entry of preserved) {
    const replay = await store.appendTranscript({
      threadId,
      runId: entry.runId,
      turnId: entry.turnId,
      kind: entry.kind,
      parentEntryId,
      payload: {
        ...entry.payload,
        compactionReplay: true,
        originEntryId: entry.entryId,
      },
    })
    parentEntryId = replay.entryId
  }

  const preTokens = manifest.estimatedContextTokens
  const postTokens = estimateTokens(summary) + preserved.reduce((sum, entry) => sum + estimateTokens(JSON.stringify(entry.payload)), 0)
  const record: CompactionRecord = {
    schemaVersion: 2,
    compactionId,
    threadId,
    boundaryEntryId: boundary.entryId,
    summaryEntryId: summaryEntry.entryId,
    firstCompactedEntryId: firstCompacted.entryId,
    lastCompactedEntryId: compacted.at(-1)?.entryId ?? firstCompacted.entryId,
    preservedFromEntryId: preserved[0]?.entryId ?? null,
    summary,
    strategy,
    preTokens,
    postTokens,
    createdAt: nowUtc(),
  }
  await store.appendCompaction(record)
  return record
}

// rebuildThreadMemory
//
// 自动区只由摘要模型维护；用户固定区逐字保留，并通过 optimistic version 避免覆盖并发编辑。
export async function rebuildThreadMemory(
  store: ThreadContextStore,
  threadId: string,
  config: AgentRuntimeConfig['context'],
  summarize: ContextSummarizer,
  force = false,
  excludeRunId?: string,
): Promise<ThreadMemoryDocument> {
  const [manifest, current, chain] = await Promise.all([
    store.getThreadManifest(threadId),
    store.getThreadMemory(threadId),
    store.activeTranscript(threadId),
  ])
  const threshold = current.version === 0 ? config.memoryInitTokens : config.memoryUpdateTokens
  const growth = manifest.estimatedContextTokens - manifest.memoryBasedOnTokens
  if (!force && (!config.memoryEnabled || growth < threshold)) return current
  const eligibleChain = excludeRunId ? chain.filter(entry => entry.runId !== excludeRunId) : chain
  const lastSemanticEntry = findLastEntry(eligibleChain, isModelVisibleEntry)
  if (!force && (!lastSemanticEntry || !isCompletedTurnBoundary(lastSemanticEntry))) return current

  const sourceText = formatEntriesForSummary(stripCompactionReplay(eligibleChain)).slice(-80_000)
  const prompt = [
    '请更新当前线程的会话记忆。只能使用给出的可见对话，不得推测。',
    '必须保留固定章节标题；每节内容应短而信息密集。',
    '不要把当前临时任务、运行日志流水账、可从仓库推导的代码结构或 AGENTS.md 已记录规则写成长期事实。',
    '涉及文件、函数、配置、图层、工具能力或数据源时，只记录当前对话已经明确验证过的状态；不要把记忆当成未来事实。',
    '',
    `章节模板：\n${THREAD_MEMORY_TEMPLATE}`,
    '',
    `现有自动记忆：\n${current.generatedContent || '（无）'}`,
    '',
    `新增对话：\n${sourceText}`,
  ].join('\n')
  const generated = (await summarize(prompt)).trim()
  if (!generated) throw new Error('memory 摘要为空')
  const content = renderMemory(generated, current.pinnedContent)
  return store.updateThreadMemory(
    threadId,
    content,
    current.version,
    'system',
    lastSemanticEntry?.entryId ?? null,
  )
}

export function buildManualMemoryContent(generatedContent: string, pinnedContent: string): string {
  return renderMemory(generatedContent, pinnedContent)
}

async function hydrateContentReferences(
  store: ThreadContextStore,
  entries: TranscriptEntry[],
): Promise<TranscriptEntry[]> {
  return Promise.all(entries.map(async entry => {
    if (entry.kind !== 'tool_result' || stringField(entry.payload.content)) return entry
    const reference = parseContentRef(entry.payload.contentRef)
    if (!reference) return entry
    const bytes = await store.readConversationObject(reference)
    return { ...entry, payload: { ...entry.payload, content: Buffer.from(bytes).toString('utf8') } }
  }))
}

// 资源索引只在用户明确要求继续或复用时进入模型上下文，避免把历史事实静默注入新任务。
async function buildThreadResourceMessage(
  store: ThreadContextStore,
  threadId: string,
  entries: TranscriptEntry[],
  artifactResources: readonly VisibleArtifactResource[],
  currentRunId?: string,
): Promise<string | null> {
  const currentUserEntry = findLastEntry(entries, entry => entry.kind === 'message' && entry.payload.role === 'user')
  const query = stringField(currentUserEntry?.payload.content) ?? ''
  if (!/(继续|沿用|复用|之前|刚才|上次|已有|已上传|文件|图层|结果|产物|引用|报告)/u.test(query)) return null

  const files = await new RuntimeFileStore(store.runtimeRoot).list(threadId)
  const allRuns = store.listRunsForThread(threadId)
  const currentRun = currentRunId
    ? allRuns.find(run => run.id === currentRunId)
    : undefined
  const runs = currentRun
    ? allRuns.filter(run => (
        run.workspaceId === currentRun.workspaceId
        && Date.parse(run.createdAt) <= Date.parse(currentRun.createdAt)
      ))
    : allRuns
  const valueRefs = runs.flatMap(run => run.state.toolValueRefs).slice(-40)
  if (!files.length && !artifactResources.length && !valueRefs.length) return null
  return [
    '<thread-resources>',
    '以下是当前线程已经过平台所有权校验的资源索引。不得根据名称推测内容；只有 availability=available 且带 sandboxPath 的 Artifact 才能从沙箱读取。',
    ...files.slice(-24).map(file => `file: id=${file.id}; name=${file.name}; sha256=${file.contentHash}`),
    ...artifactResources.slice(-24).map(formatArtifactResource),
    ...valueRefs.map(reference => `valueRef: refId=${reference.refId}; kind=${reference.kind}; label=${reference.label}`),
    '</thread-resources>',
  ].join('\n')
}

function formatArtifactResource(resource: VisibleArtifactResource): string {
  const fields = [
    `artifact: artifactId=${resource.artifactId}`,
    `originRunId=${resource.runId}`,
    `name=${resource.name}`,
    `type=${resource.artifactType}`,
    `availability=${resource.availability}`,
  ]
  if (resource.availability === 'available') fields.push(`sandboxPath=${resource.sandboxPath}`)
  else if (resource.unavailableReason) fields.push(`reason=${resource.unavailableReason}`)
  return fields.join('; ')
}

function transcriptEntriesToChatMessages(entries: TranscriptEntry[]): ConversationChatMessage[] {
  const assistantContentByCallId = assistantToolContentByCallId(entries)
  const resultsByCallId = new Map(
    entries
      .filter(entry => entry.kind === 'tool_result')
      .flatMap(entry => {
        const callId = stringField(entry.payload.callId)
        return callId ? [[callId, entry] as const] : []
      }),
  )
  const consumedResults = new Set<string>()
  const messages: ConversationChatMessage[] = []

  for (const entry of entries) {
    if (entry.kind === 'tool_call') {
      const callId = stringField(entry.payload.callId)
      const result = callId ? resultsByCallId.get(callId) : null
      if (!callId || !result) continue
      messages.push(...toChatMessages(entry, assistantContentByCallId.get(callId)), ...toChatMessages(result))
      consumedResults.add(callId)
      continue
    }
    if (entry.kind === 'tool_result') {
      const callId = stringField(entry.payload.callId)
      if (!callId || consumedResults.has(callId)) continue
      // 历史工具结果必须紧跟对应 assistant tool_call。孤立结果只保留在
      // transcript 事实源和 run items 中，避免下一轮模型请求违反协议。
      continue
    }
    messages.push(...toChatMessages(entry))
  }
  return messages
}

function assistantToolContentByCallId(entries: TranscriptEntry[]): Map<string, string> {
  const contentByCallId = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'tool_call') {
      const callId = stringField(entry.payload.callId)
      const content = stringField(entry.payload.assistantContent)
      if (callId && content && !contentByCallId.has(callId)) contentByCallId.set(callId, content)
      continue
    }
    if (!isAssistantContentCheckpoint(entry)) continue
    const callId = stringField(entry.payload.callId)
    const content = stringField(entry.payload.content)
    if (callId && content && !contentByCallId.has(callId)) contentByCallId.set(callId, content)
  }
  return contentByCallId
}

function parseContentRef(value: unknown): ContentRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.algorithm !== 'sha256' || typeof record.hash !== 'string') return null
  return {
    algorithm: 'sha256',
    hash: record.hash,
    mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    relativePath: typeof record.relativePath === 'string' ? record.relativePath : '',
  }
}

function toChatMessages(entry: TranscriptEntry, assistantContentOverride?: string): ConversationChatMessage[] {
  if (entry.kind === 'message') {
    const role = stringField(entry.payload.role)
    const content = stringField(entry.payload.content)
    return role && content ? [{ role, content }] : []
  }
  if (entry.kind === 'tool_call') {
    const callId = stringField(entry.payload.callId)
    const name = stringField(entry.payload.name)
    if (!callId || !name) return []
    const args = typeof entry.payload.arguments === 'string'
      ? entry.payload.arguments
      : JSON.stringify(entry.payload.arguments ?? {})
    return [{
      role: 'assistant',
      content: assistantContentOverride ?? stringField(entry.payload.assistantContent),
      tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
    }]
  }
  if (entry.kind === 'tool_result') {
    const callId = stringField(entry.payload.callId)
    if (!callId) return []
    const content = stringField(entry.payload.content)
      ?? stringField(entry.payload.summary)
      ?? JSON.stringify({ contentRef: entry.payload.contentRef ?? null })
    return [{ role: 'tool', content, tool_call_id: callId }]
  }
  if (entry.kind === 'compact_summary') {
    const content = stringField(entry.payload.content)
    return content ? [{ role: 'system', content: `<conversation-summary>\n${content}\n</conversation-summary>` }] : []
  }
  return []
}

function preserveRecentTurns(entries: TranscriptEntry[], turnCount: number): TranscriptEntry[] {
  const summary = findLastEntry(entries, entry => entry.kind === 'compact_summary')
  const visible = entries.filter(entry => entry.kind !== 'compact_boundary'
    && (entry.kind !== 'checkpoint' || isAssistantContentCheckpoint(entry)))
  const preserveIndex = findPreserveStart(visible, turnCount)
  const recent = visible.slice(Math.max(0, preserveIndex))
  return summary && !recent.some(entry => entry.entryId === summary.entryId) ? [summary, ...recent] : recent
}

function findPreserveStart(entries: TranscriptEntry[], turnCount: number): number {
  let userTurns = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.kind === 'message' && entry.payload.role === 'user') {
      userTurns += 1
      if (userTurns >= turnCount) return index
    }
  }
  return 0
}

function stripCompactionReplay(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter(entry => entry.payload.compactionReplay !== true)
}

function isModelVisibleEntry(entry: TranscriptEntry): boolean {
  return ['message', 'tool_call', 'tool_result', 'compact_summary'].includes(entry.kind)
    || isAssistantContentCheckpoint(entry)
}

function isAssistantContentCheckpoint(entry: TranscriptEntry): boolean {
  return entry.kind === 'checkpoint'
    && entry.payload.type === 'assistant_content_for_tool_call'
    && typeof entry.payload.callId === 'string'
    && typeof entry.payload.content === 'string'
}

function isCompletedTurnBoundary(entry: TranscriptEntry): boolean {
  return entry.kind === 'tool_result'
    || entry.kind === 'compact_summary'
    || (entry.kind === 'message' && entry.payload.role === 'assistant')
}

function buildCompactionPrompt(entries: TranscriptEntry[]): string {
  return `请压缩以下历史对话，只保留可验证信息，不得推测或补全。\n` +
    `严格按以下 Markdown 标题输出：当前目标、用户约束、已确认事实、数据与产物引用、未完成事项、关键术语。\n\n` +
    formatEntriesForSummary(entries)
}

function formatEntriesForSummary(entries: TranscriptEntry[]): string {
  return entries.flatMap(entry => {
    if (entry.kind === 'message') {
      return [`[${String(entry.payload.role ?? 'message')}] ${String(entry.payload.content ?? '')}`]
    }
    if (entry.kind === 'tool_call') {
      return [`[tool_call ${String(entry.payload.name ?? '')}] ${JSON.stringify(entry.payload.arguments ?? {})}`]
    }
    if (entry.kind === 'tool_result') {
      return [`[tool_result ${String(entry.payload.name ?? '')}] ${String(entry.payload.summary ?? entry.payload.content ?? '')}`]
    }
    if (entry.kind === 'compact_summary') return [`[已有摘要] ${String(entry.payload.content ?? '')}`]
    return []
  }).join('\n')
}

function renderMemory(generated: string, pinned: string): string {
  return `${generated.trim()}\n\n## 用户固定记忆\n${USER_NOTES_START}\n${pinned.trim()}\n${USER_NOTES_END}\n`
}

function estimateMessages(messages: ConversationChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0)
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && predicate(value)) return index
  }
  return -1
}

function findLastEntry<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  const index = findLastIndex(values, predicate)
  if (index < 0) return undefined
  return values[index]
}
