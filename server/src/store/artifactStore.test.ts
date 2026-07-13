import { describe, expect, it, vi } from 'vitest'

import type { AgentThreadRecord, AnalysisRun, ArtifactRef, SessionRecord } from '../schemas/types.js'
import { ArtifactStore } from './artifactStore.js'
import { ConversationIndexStore } from './conversationIndexStore.js'
import type { ArtifactRepository } from './postgres/artifactIndexStore.js'

function createFixture(persistArtifact = vi.fn().mockResolvedValue(undefined)) {
  const index = new ConversationIndexStore()
  const session = {
    id: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
  } as SessionRecord
  const thread = {
    id: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    latestArtifactId: null,
    latestArtifactName: null,
    updatedAt: '2026-07-12T00:00:00.000Z',
    status: 'active',
  } as AgentThreadRecord
  const run = {
    id: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
  } as AnalysisRun
  index.load({ sessions: [session], threads: [thread], runs: [run] })
  const artifactRepository = {
    persistArtifact,
  } as unknown as ArtifactRepository
  return {
    index,
    artifactRepository,
    store: new ArtifactStore(index, artifactRepository),
  }
}

const artifact: ArtifactRef = {
  artifactId: 'artifact_1',
  runId: 'run_1',
  artifactType: 'raster_png',
  name: '雷达组网拼图',
  uri: '/api/v1/results/artifact_1/file',
  metadata: { relativePath: 'artifacts/run_1/artifact_1.png' },
  isIntermediate: false,
}

describe('ArtifactStore', () => {
  it('persists the artifact fact and updates the thread navigation projection', async () => {
    const fixture = createFixture()

    await fixture.store.persist(artifact)

    expect(fixture.artifactRepository.persistArtifact).toHaveBeenCalledWith(artifact, {
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'workspace',
      threadId: 'thread_1',
    })
    expect(fixture.index.getThread('thread_1')).toMatchObject({
      latestArtifactId: 'artifact_1',
      latestArtifactName: '雷达组网拼图',
    })
  })

  it('does not update memory when the atomic PostgreSQL write fails', async () => {
    const fixture = createFixture(vi.fn().mockRejectedValue(new Error('database unavailable')))

    await expect(fixture.store.persist(artifact)).rejects.toThrow('database unavailable')

    expect(fixture.artifactRepository.persistArtifact).toHaveBeenCalledOnce()
    expect(fixture.index.getThread('thread_1').latestArtifactId).toBeNull()
  })
})
