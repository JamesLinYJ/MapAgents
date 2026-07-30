// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 持久化门面测试夹具
//
//   文件:       persistenceFacadeHarness.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../src/db/connection.js'
import type { ArtifactRef } from '../src/schemas/types.js'
import { PlatformPersistenceFacade } from '../src/store/platformPersistenceFacade.js'
import type {
  ArtifactRecord,
  ArtifactOwnerProjection,
  ArtifactRepository,
  VisibleArtifactQuery,
} from '../src/store/postgres/artifactRepository.js'
import { InMemoryConversationPersistence } from './inMemoryConversationPersistence.js'

class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly records = new Map<string, ArtifactRecord>()

  async persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    this.records.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      threadId: owner.threadId,
      runCreatedAt: owner.runCreatedAt,
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      display: structuredClone(artifact.display),
      metadata: structuredClone(artifact.metadata),
      relativePath,
      createdAt: new Date().toISOString(),
    })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    for (const [artifactId, record] of this.records) {
      if (record.runId === runId) this.records.delete(artifactId)
    }
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const record = this.records.get(artifactId)
    return record ? structuredClone(record) : null
  }

  async listVisibleArtifacts(query: VisibleArtifactQuery): Promise<ArtifactRecord[]> {
    const artifactIds = query.artifactIds ? new Set(query.artifactIds) : null
    return [...this.records.values()]
      .filter(record => (
        record.threadId === query.threadId
        && record.workspaceId === query.workspaceId
        && Date.parse(record.runCreatedAt) <= Date.parse(query.visibleAt)
        && (!artifactIds || artifactIds.has(record.artifactId))
      ))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(query.limit ? -query.limit : undefined)
      .map(record => structuredClone(record))
  }
}

export class PersistenceFacadeTestHarness {
  readonly conversationPersistence = new InMemoryConversationPersistence()
  readonly artifactRepository = new InMemoryArtifactRepository()

  create(storageRoot: string, db: Database = noOpDatabase()): PlatformPersistenceFacade {
    return new PlatformPersistenceFacade(db, storageRoot, {
      conversationPersistence: this.conversationPersistence,
      artifactRepository: this.artifactRepository,
    })
  }
}

export function createTestPersistenceFacade(storageRoot: string, db?: Database): PlatformPersistenceFacade {
  return new PersistenceFacadeTestHarness().create(storageRoot, db)
}

function noOpDatabase(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}
