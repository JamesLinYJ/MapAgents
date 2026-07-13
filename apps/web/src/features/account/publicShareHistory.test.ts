import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@geo-agent-platform/shared-types'
import { mergePublicShareHistory } from './publicShareHistory'

function entry(entryId: string, seq: number, text: string): TranscriptEntry {
  return {
    schemaVersion: 2,
    seq,
    entryId,
    parentEntryId: null,
    logicalParentEntryId: null,
    threadId: 'thread-1',
    runId: null,
    turnId: null,
    kind: 'message',
    timestamp: '2026-07-13T00:00:00.000Z',
    payload: { text },
  }
}

describe('mergePublicShareHistory', () => {
  it('prepends older pages, restores sequence order, and removes retry duplicates', () => {
    const current = [entry('entry-3', 3, 'current-3'), entry('entry-4', 4, 'current-4')]
    const older = [entry('entry-2', 2, 'older-2'), entry('entry-3', 3, 'stale-3'), entry('entry-1', 1, 'older-1')]

    const merged = mergePublicShareHistory(current, older)

    expect(merged.map(item => item.entryId)).toEqual(['entry-1', 'entry-2', 'entry-3', 'entry-4'])
    expect(merged.find(item => item.entryId === 'entry-3')?.payload.text).toBe('current-3')
  })
})
