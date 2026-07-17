// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Artifact 持久化契约
//
//   文件:       artifactRepository.ts
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ArtifactDisplay, ArtifactRef } from '../../schemas/types.js'

export interface ArtifactOwnerProjection {
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  threadId: string | null
}

export interface ArtifactRecord {
  artifactId: string
  runId: string
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  artifactType: string
  name: string
  uri: string
  display: ArtifactDisplay
  metadata: Record<string, unknown>
  relativePath: string
}

export interface ArtifactReader {
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>
}

export interface ArtifactRepository extends ArtifactReader {
  persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void>
  deleteRunArtifacts(runId: string): Promise<void>
}
