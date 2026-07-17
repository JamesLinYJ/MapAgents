// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Artifact 元数据仓储
//
//   文件:       artifactMetadataRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformArtifacts } from '../../db/schema.js'
import { artifactDisplaySchema, type ArtifactRef } from '../../schemas/types.js'
import type { ArtifactOwnerProjection, ArtifactRecord, ArtifactReader } from './artifactRepository.js'

/** Artifact 元数据、内容引用和归属的单资源仓储。 */
export class ArtifactMetadataRepository implements ArtifactReader {
  constructor(private readonly db: Database) {}

  async upsert(
    tx: DatabaseTransaction,
    artifact: ArtifactRef,
    owner: ArtifactOwnerProjection,
    relativePath: string,
  ): Promise<void> {
    await tx.insert(platformArtifacts).values({
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      displayJson: artifact.display,
      metadataJson: artifact.metadata,
      contentRelativePath: relativePath,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: platformArtifacts.artifactId,
      set: {
        name: artifact.name,
        uri: artifact.uri,
        displayJson: artifact.display,
        metadataJson: artifact.metadata,
        contentRelativePath: relativePath,
        workspaceId: owner.workspaceId,
        createdByUserId: owner.createdByUserId,
        visibility: owner.visibility,
      },
    })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    await this.db.delete(platformArtifacts).where(eq(platformArtifacts.runId, runId))
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const rows = await this.db
      .select()
      .from(platformArtifacts)
      .where(eq(platformArtifacts.artifactId, artifactId))
      .limit(1)
    const row = rows[0]
    return row ? mapArtifactRow(row) : null
  }
}

function mapArtifactRow(row: typeof platformArtifacts.$inferSelect): ArtifactRecord {
  return {
    artifactId: row.artifactId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    artifactType: row.artifactType,
    name: row.name,
    uri: row.uri,
    display: artifactDisplaySchema.parse(row.displayJson),
    metadata: requireRecord(row.metadataJson, 'metadata_json'),
    relativePath: row.contentRelativePath,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Artifact ${label} 必须是对象。`)
  }
  return value as Record<string, unknown>
}
