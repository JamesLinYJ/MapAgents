// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 查询索引存储
//
//   文件:       artifactIndexStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { platformArtifacts } from '../../db/schema.js'
import type { ArtifactRef } from '../../schemas/types.js'

export interface ArtifactOwnerProjection {
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
}

export interface ArtifactIndexRecord {
  artifactId: string
  runId: string
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  artifactType: string
  name: string
  uri: string
  metadata: Record<string, unknown>
  relativePath: string
}

// Artifact 正文仍在文件型 conversation store 中；Postgres 只保存可授权、
// 可下载和可检索的查询索引。索引写入硬失败，避免 UI 看到不存在的下载项。
export class ArtifactIndexStore {
  constructor(private readonly db: Database) {}

  async indexArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)

    await this.db
      .insert(platformArtifacts)
      .values({
        artifactId: artifact.artifactId,
        runId: artifact.runId,
        workspaceId: owner.workspaceId,
        createdByUserId: owner.createdByUserId,
        visibility: owner.visibility,
        artifactType: artifact.artifactType,
        name: artifact.name,
        uri: artifact.uri,
        metadataJson: artifact.metadata,
        geojsonRelativePath: relativePath,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: platformArtifacts.artifactId,
        set: {
          name: artifact.name,
          uri: artifact.uri,
          metadataJson: artifact.metadata,
          geojsonRelativePath: relativePath,
          workspaceId: owner.workspaceId,
          createdByUserId: owner.createdByUserId,
          visibility: owner.visibility,
        },
      })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    await this.db.delete(platformArtifacts).where(eq(platformArtifacts.runId, runId))
  }

  async getArtifact(artifactId: string): Promise<ArtifactIndexRecord | null> {
    const rows = await this.db
      .select()
      .from(platformArtifacts)
      .where(eq(platformArtifacts.artifactId, artifactId))
      .limit(1)
    return rows[0] ? mapArtifactRow(rows[0]) : null
  }
}

function mapArtifactRow(row: typeof platformArtifacts.$inferSelect): ArtifactIndexRecord {
  return {
    artifactId: row.artifactId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    artifactType: row.artifactType,
    name: row.name,
    uri: row.uri,
    metadata: isRecord(row.metadataJson) ? row.metadataJson : {},
    relativePath: row.geojsonRelativePath,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
