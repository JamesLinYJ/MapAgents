import type { TranscriptEntry } from '@geo-agent-platform/shared-types'

/** 合并公开分享的历史分页；以 entryId 去重并恢复线程内的递增顺序。 */
export function mergePublicShareHistory(
  currentEntries: TranscriptEntry[],
  olderEntries: TranscriptEntry[],
): TranscriptEntry[] {
  const entriesById = new Map<string, TranscriptEntry>()
  for (const entry of olderEntries) entriesById.set(entry.entryId, entry)
  for (const entry of currentEntries) entriesById.set(entry.entryId, entry)
  return [...entriesById.values()].sort((left, right) => left.seq - right.seq)
}
