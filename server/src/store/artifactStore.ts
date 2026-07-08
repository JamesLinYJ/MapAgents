// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 资源存储
//
//   文件:       artifactStore.ts
//
//   日期:       2026年07月07日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { AnalysisRun, ArtifactRef } from '../schemas/types.js'
import type { ConversationIndexStore } from './conversationIndexStore.js'
import type { FileConversationStore } from './fileConversationStore.js'
import type { ArtifactIndexStore } from './postgres/artifactIndexStore.js'

// Artifact 的事实源是 run 目录下的 artifacts.jsonl；Postgres 只保存可重建查询索引。
// 本 store 统一维护两边写入顺序，避免 facade 或工具层各自补索引。
export class ArtifactStore {
  constructor(
    private readonly index: ConversationIndexStore,
    private readonly conversationStore: FileConversationStore,
    private readonly artifactIndexStore: ArtifactIndexStore,
  ) {}

  async hydrateIndexForRuns(runs: Iterable<AnalysisRun>): Promise<void> {
    for (const run of runs) {
      for (const artifact of await this.conversationStore.listArtifacts(run.id)) {
        await this.indexArtifact(artifact)
      }
    }
  }

  async persist(artifact: ArtifactRef): Promise<void> {
    this.requireRelativePath(artifact)
    await this.conversationStore.appendArtifact(artifact.runId, artifact)
    await this.indexArtifact(artifact)
  }

  private async indexArtifact(artifact: ArtifactRef): Promise<void> {
    this.requireRelativePath(artifact)
    const owner = this.index.getRunOrNull(artifact.runId)
    await this.artifactIndexStore.indexArtifact(artifact, {
      workspaceId: owner?.workspaceId ?? null,
      createdByUserId: owner?.createdByUserId ?? null,
      visibility: owner?.visibility ?? 'workspace',
    })
  }

  private requireRelativePath(artifact: ArtifactRef): string {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    return relativePath
  }
}

