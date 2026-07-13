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
import { platformArtifacts, platformThreads } from '../../db/schema.js'
import type { ArtifactRef } from '../../schemas/types.js'

export interface ArtifactOwnerProjection {
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  threadId: string | null
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

export interface ArtifactRepository {
  persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void>
  deleteRunArtifacts(runId: string): Promise<void>
  getArtifact(artifactId: string): Promise<ArtifactIndexRecord | null>
}

// PostgreSQL 是 Artifact 元数据与归属的事实源，文件系统只保存由
// contentRelativePath 指向的二进制内容。Artifact 与线程导航投影原子提交。
export class ArtifactIndexStore implements ArtifactRepository {
  constructor(private readonly db: Database) {}

  async persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)

    await this.db.transaction(async tx => {
      await tx.insert(platformArtifacts).values({
        artifactId: artifact.artifactId,
        runId: artifact.runId,
        workspaceId: owner.workspaceId,
        createdByUserId: owner.createdByUserId,
        visibility: owner.visibility,
        artifactType: artifact.artifactType,
        name: artifact.name,
        uri: artifact.uri,
        metadataJson: artifact.metadata,
        contentRelativePath: relativePath,
        createdAt: new Date(),
      }).onConflictDoUpdate({
        target: platformArtifacts.artifactId,
        set: {
          name: artifact.name,
          uri: artifact.uri,
          metadataJson: artifact.metadata,
          contentRelativePath: relativePath,
          workspaceId: owner.workspaceId,
          createdByUserId: owner.createdByUserId,
          visibility: owner.visibility,
        },
      })
      if (!artifact.isIntermediate && owner.threadId) {
        const updated = await tx.update(platformThreads).set({
          latestArtifactId: artifact.artifactId,
          latestArtifactName: artifact.name,
          updatedAt: new Date(),
        }).where(eq(platformThreads.threadId, owner.threadId)).returning({ threadId: platformThreads.threadId })
        if (!updated[0]) throw new Error(`Artifact 所属线程 '${owner.threadId}' 不存在`)
      }
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
    relativePath: row.contentRelativePath,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
