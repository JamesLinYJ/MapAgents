// +-------------------------------------------------------------------------
//
//   地理智能平台 - 增量对话投影索引
//
//   文件:       projection.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import type { ConversationItem } from '@geo-agent-platform/shared-types'

export type ConversationProjectionSource = 'canonical' | 'live'

export interface ConversationProjectionStats {
  upserts: number
  removals: number
  comparisons: number
  materializations: number
}

/**
 * 对话实时流的可重建索引。
 *
 * `itemsById` 是 itemId 的唯一索引，`orderedIds` 只在插入或更新时维护，
 * `transcriptEntryIndex` 负责 canonical 与 live overlay 的替换关系。调用方
 * 不需要在每个 run.item 到达时重新扫描、排序完整 ConversationItem[]。
 */
export class ConversationProjectionIndex {
  private readonly itemsById = new Map<string, ConversationItem>()
  private readonly orderedIds: string[] = []
  private readonly transcriptEntryIndex = new Map<string, string>()
  private readonly transcriptEntryMembers = new Map<string, Set<string>>()
  private readonly itemTranscriptEntry = new Map<string, string>()
  private readonly activeSources = new Map<string, ConversationProjectionSource>()
  private readonly sourceRecords: Record<ConversationProjectionSource, Map<string, ConversationItem>> = {
    canonical: new Map<string, ConversationItem>(),
    live: new Map<string, ConversationItem>(),
  }
  private readonly sourceItems: Record<ConversationProjectionSource, Set<string>> = {
    canonical: new Set<string>(),
    live: new Set<string>(),
  }
  private readonly toolCallIndex = new Map<string, string>()
  private readonly toolOutputIndex = new Map<string, string>()
  private readonly assistantContentIndex = new Map<string, string>()
  private snapshot: ConversationItem[] | null = null
  private readonly counters: ConversationProjectionStats = {
    upserts: 0,
    removals: 0,
    comparisons: 0,
    materializations: 0,
  }

  constructor(items: ReadonlyArray<ConversationItem> = [], source: ConversationProjectionSource = 'canonical') {
    this.replaceSource(source, items)
  }

  get size(): number {
    return this.orderedIds.length
  }

  /** 返回稳定的展示快照；没有更新时复用同一个数组。 */
  toArray(): ConversationItem[] {
    if (!this.snapshot) {
      this.snapshot = this.orderedIds.flatMap(itemId => {
        const item = this.itemsById.get(itemId)
        return item ? [item] : []
      })
      this.counters.materializations += 1
    }
    return this.snapshot
  }

  /** 返回索引的只读视图，供调试和架构测试验证边界。 */
  getIndexSnapshot(): {
    itemsById: ReadonlyMap<string, ConversationItem>
    orderedIds: readonly string[]
    transcriptEntryIndex: ReadonlyMap<string, string>
  } {
    return {
      itemsById: this.itemsById,
      orderedIds: this.orderedIds,
      transcriptEntryIndex: this.transcriptEntryIndex,
    }
  }

  getStats(): ConversationProjectionStats {
    return { ...this.counters }
  }

  /**
   * 将一个来源的当前快照同步到索引。
   *
   * 这不是全量重建：未变化的 item 保留原索引，删除项只从其来源拥有的集合中
   * 移除，新增/变更项走单条 upsert。适合 canonical 历史刷新和 live 流切换。
   */
  replaceSource(source: ConversationProjectionSource, items: ReadonlyArray<ConversationItem>): void {
    const incomingIds = new Set(items.map(item => item.itemId))
    for (const itemId of this.sourceItems[source]) {
      if (!incomingIds.has(itemId)) this.removeSourceItem(itemId, source)
    }
    for (const item of items) this.upsert(item, source)
  }

  upsert(item: ConversationItem, source: ConversationProjectionSource = 'live'): void {
    const previous = this.sourceRecords[source].get(item.itemId)
    if (previous === item) return
    this.counters.upserts += 1

    const activeSource = this.activeSources.get(item.itemId)
    if (activeSource === source) this.deactivate(item.itemId)
    this.sourceRecords[source].set(item.itemId, item)
    this.sourceItems[source].add(item.itemId)

    const transcriptId = transcriptEntryId(item)
    const existingIdsForTranscript = transcriptId
      ? [...this.transcriptEntryMembers.get(transcriptId) ?? []].filter(itemId => itemId !== item.itemId)
      : []
    const conflictingIds = existingIdsForTranscript.filter(itemId => this.activeSources.get(itemId) !== source)
    if (conflictingIds.length > 0) {
      const existingSources = conflictingIds
        .map(itemId => this.activeSources.get(itemId))
        .filter((existingSource): existingSource is ConversationProjectionSource => Boolean(existingSource))
      if (existingSources.some(existingSource => sourceRank(existingSource) > sourceRank(source))) return
      for (const existingId of conflictingIds) {
        this.deactivate(existingId)
      }
    }

    const currentSource = this.activeSources.get(item.itemId)
    if (currentSource && sourceRank(currentSource) > sourceRank(source)) return

    this.activate(item, source)
  }

  upsertMany(items: ReadonlyArray<ConversationItem>, source: ConversationProjectionSource = 'live'): void {
    for (const item of items) this.upsert(item, source)
  }

  remove(itemId: string): void {
    for (const source of ['canonical', 'live'] as const) {
      if (this.sourceRecords[source].has(itemId)) this.removeSourceItem(itemId, source)
    }
    if (this.itemsById.has(itemId)) this.deactivate(itemId)
  }

  private removeSourceItem(itemId: string, source: ConversationProjectionSource): void {
    const item = this.sourceRecords[source].get(itemId)
    if (!item) {
      this.sourceItems[source].delete(itemId)
      return
    }
    this.sourceRecords[source].delete(itemId)
    this.sourceItems[source].delete(itemId)
    if (this.activeSources.get(itemId) === source) this.deactivate(itemId)
    if (!this.activeSources.has(itemId)) this.activateFallbackForItemId(itemId)
    const transcriptId = transcriptEntryId(item)
    if (transcriptId && !this.transcriptEntryIndex.has(transcriptId)) this.activateFallback(transcriptId)
  }

  private activate(item: ConversationItem, source: ConversationProjectionSource): void {
    if (this.itemsById.has(item.itemId)) this.deactivate(item.itemId)
    this.itemsById.set(item.itemId, item)
    this.activeSources.set(item.itemId, source)
    this.indexItem(item)
    this.insertOrderedId(item.itemId)
    this.ensureAssistantContentBeforeToolCall(item.callId)
    this.ensureAssistantContentBeforeToolCall(assistantContentForCall(item))
    this.snapshot = null
  }

  private activateFallback(transcriptId: string): void {
    for (const source of ['live', 'canonical'] as const) {
      for (const candidate of this.sourceRecords[source].values()) {
        if (transcriptEntryId(candidate) !== transcriptId || this.activeSources.has(candidate.itemId)) continue
        this.activate(candidate, source)
      }
    }
  }

  private activateFallbackForItemId(itemId: string): void {
    for (const source of ['live', 'canonical'] as const) {
      const candidate = this.sourceRecords[source].get(itemId)
      if (candidate) {
        this.activate(candidate, source)
        return
      }
    }
  }

  private deactivate(itemId: string): void {
    if (!this.itemsById.has(itemId)) return
    this.counters.removals += 1
    const position = this.orderedIds.indexOf(itemId)
    if (position >= 0) this.orderedIds.splice(position, 1)
    const item = this.itemsById.get(itemId)
    if (item) this.unindexItem(item)
    this.itemsById.delete(itemId)
    this.activeSources.delete(itemId)
    this.snapshot = null
  }

  private indexItem(item: ConversationItem): void {
    const transcriptId = transcriptEntryId(item)
    if (transcriptId) {
      this.transcriptEntryIndex.set(transcriptId, item.itemId)
      this.itemTranscriptEntry.set(item.itemId, transcriptId)
      const members = this.transcriptEntryMembers.get(transcriptId) ?? new Set<string>()
      members.add(item.itemId)
      this.transcriptEntryMembers.set(transcriptId, members)
    }
    if (item.itemType === 'function_call' && item.callId) this.toolCallIndex.set(item.callId, item.itemId)
    if (item.itemType === 'function_call_output' && item.callId) this.toolOutputIndex.set(item.callId, item.itemId)
    const assistantCallId = assistantContentForCall(item)
    if (assistantCallId) this.assistantContentIndex.set(assistantCallId, item.itemId)
  }

  private unindexItem(item: ConversationItem): void {
    const transcriptId = this.itemTranscriptEntry.get(item.itemId)
    if (transcriptId && this.transcriptEntryIndex.get(transcriptId) === item.itemId) {
      const members = this.transcriptEntryMembers.get(transcriptId)
      const remaining = members ? [...members].filter(itemId => itemId !== item.itemId) : []
      const nextId = remaining.at(-1)
      if (nextId) this.transcriptEntryIndex.set(transcriptId, nextId)
      else this.transcriptEntryIndex.delete(transcriptId)
    }
    if (transcriptId) {
      const members = this.transcriptEntryMembers.get(transcriptId)
      members?.delete(item.itemId)
      if (members && members.size === 0) this.transcriptEntryMembers.delete(transcriptId)
    }
    this.itemTranscriptEntry.delete(item.itemId)
    if (item.callId && item.itemType === 'function_call' && this.toolCallIndex.get(item.callId) === item.itemId) {
      this.toolCallIndex.delete(item.callId)
    }
    if (item.callId && item.itemType === 'function_call_output' && this.toolOutputIndex.get(item.callId) === item.itemId) {
      this.toolOutputIndex.delete(item.callId)
    }
    const assistantCallId = assistantContentForCall(item)
    if (assistantCallId && this.assistantContentIndex.get(assistantCallId) === item.itemId) {
      this.assistantContentIndex.delete(assistantCallId)
    }
  }

  private insertOrderedId(itemId: string): void {
    const item = this.itemsById.get(itemId)
    const lastItem = this.itemsById.get(this.orderedIds.at(-1) ?? '')
    if (item && lastItem) {
      this.counters.comparisons += 1
      if (compareConversationItems(lastItem, item) <= 0) {
        this.orderedIds.push(itemId)
        return
      }
    }
    let low = 0
    let high = this.orderedIds.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const middleItem = this.itemsById.get(this.orderedIds[middle]!)
      if (!middleItem || !item) break
      this.counters.comparisons += 1
      if (compareConversationItems(middleItem, item) <= 0) low = middle + 1
      else high = middle
    }
    this.orderedIds.splice(low, 0, itemId)
  }

  private ensureAssistantContentBeforeToolCall(callId: string | null): void {
    if (!callId) return
    const messageId = this.assistantContentIndex.get(callId)
    const toolId = this.toolCallIndex.get(callId)
    if (!messageId || !toolId || messageId === toolId) return
    const messageIndex = this.orderedIds.indexOf(messageId)
    const toolIndex = this.orderedIds.indexOf(toolId)
    if (messageIndex < 0 || toolIndex < 0 || messageIndex < toolIndex) return
    this.orderedIds.splice(messageIndex, 1)
    const nextToolIndex = this.orderedIds.indexOf(toolId)
    this.orderedIds.splice(Math.max(0, nextToolIndex), 0, messageId)
    this.snapshot = null
  }
}

export function projectConversationItems(
  canonical: ReadonlyArray<ConversationItem>,
  liveOverlay: ReadonlyArray<ConversationItem>,
): ConversationItem[] {
  const projection = new ConversationProjectionIndex(canonical, 'canonical')
  projection.upsertMany(liveOverlay, 'live')
  return projection.toArray()
}

function sourceRank(source: ConversationProjectionSource): number {
  return source === 'live' ? 2 : 1
}

function transcriptEntryId(item: ConversationItem): string | null {
  const value = item.metadata?.transcriptEntryId
  return typeof value === 'string' && value ? value : null
}

function assistantContentForCall(item: ConversationItem): string | null {
  if (item.itemType !== 'message') return null
  const value = item.metadata?.assistantContentForCallId
  return typeof value === 'string' && value ? value : null
}

function compareConversationItems(left: ConversationItem, right: ConversationItem): number {
  const leftTime = Date.parse(left.timestamp || '')
  const rightTime = Date.parse(right.timestamp || '')
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0
  if (safeLeftTime !== safeRightTime) return safeLeftTime - safeRightTime

  const leftSeq = metadataNumber(left, 'transcriptSeq')
  const rightSeq = metadataNumber(right, 'transcriptSeq')
  if (leftSeq !== rightSeq) return leftSeq - rightSeq

  const rank = itemRank(left) - itemRank(right)
  if (rank !== 0) return rank

  return left.itemId.localeCompare(right.itemId)
}

function metadataNumber(item: ConversationItem, key: string): number {
  const value = item.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function itemRank(item: ConversationItem): number {
  if (item.itemType === 'message' && item.role === 'user') return 10
  if (item.itemType === 'reasoning') return 20
  if (item.itemType === 'message' && item.role === 'assistant') return 30
  if (item.itemType === 'function_call') return 40
  if (item.itemType === 'function_call_output') return 50
  if (item.itemType === 'result') return 60
  if (item.itemType === 'error') return 70
  return 80
}
