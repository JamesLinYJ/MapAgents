// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 资源存储
//
//   文件:       artifactStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ArtifactRef } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type { ArtifactRepository } from './postgres/artifactRepository.js'

// Artifact 元数据、归属与线程导航投影都由 PostgreSQL 原子持久化；文件系统
// 只保存 metadata.relativePath 指向的内容，不再维护 artifacts.jsonl 第二事实源。
export class ArtifactStore {
  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly artifactRepository: ArtifactRepository,
  ) {}

  async persist(artifact: ArtifactRef): Promise<void> {
    this.requireRelativePath(artifact)
    const owner = this.index.getRun(artifact.runId)
    await this.artifactRepository.persistArtifact(artifact, {
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      threadId: owner.threadId,
    })
    if (artifact.isIntermediate) return
    const thread = this.index.getThreadOrNull(owner.threadId)
    if (!thread) return
    const next = {
      ...thread,
      latestArtifactId: artifact.artifactId,
      latestArtifactName: artifact.name,
      updatedAt: nowUtc(),
    }
    this.index.setThread(next)
  }

  private requireRelativePath(artifact: ArtifactRef): string {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    return relativePath
  }
}
