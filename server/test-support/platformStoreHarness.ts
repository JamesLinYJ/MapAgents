import type { Database } from '../src/db/connection.js'
import type { ArtifactRef } from '../src/schemas/types.js'
import { PostgresPlatformStore } from '../src/store/platformStore.js'
import type {
  ArtifactIndexRecord,
  ArtifactOwnerProjection,
  ArtifactRepository,
} from '../src/store/postgres/artifactIndexStore.js'
import { InMemoryConversationRepository } from './inMemoryConversationRepository.js'

class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly records = new Map<string, ArtifactIndexRecord>()

  async persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    this.records.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      metadata: structuredClone(artifact.metadata),
      relativePath,
    })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    for (const [artifactId, record] of this.records) {
      if (record.runId === runId) this.records.delete(artifactId)
    }
  }

  async getArtifact(artifactId: string): Promise<ArtifactIndexRecord | null> {
    const record = this.records.get(artifactId)
    return record ? structuredClone(record) : null
  }
}

export class PlatformStoreTestHarness {
  readonly conversationRepository = new InMemoryConversationRepository()
  readonly artifactRepository = new InMemoryArtifactRepository()

  create(storageRoot: string, db: Database = noOpDatabase()): PostgresPlatformStore {
    return new PostgresPlatformStore(db, storageRoot, {
      conversationRepository: this.conversationRepository,
      artifactRepository: this.artifactRepository,
    })
  }
}

export function createTestPlatformStore(storageRoot: string, db?: Database): PostgresPlatformStore {
  return new PlatformStoreTestHarness().create(storageRoot, db)
}

function noOpDatabase(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}
