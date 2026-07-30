// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运行时数据完整性检查
//
//   文件:       runtimeIntegrityChecker.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import PQueue from 'p-queue'
import { z } from 'zod'

import type { Database } from '../db/connection.js'
import type { RuntimeFileStore } from './fileStore.js'
import { ContentAddressedObjectStore } from './contentAddressedObjectStore.js'

interface ObjectReferenceRow {
  object_hash: string
  source: string
}

interface ArtifactReferenceRow {
  artifact_id: string
  content_relative_path: string
}

const objectReferenceRowsSchema = z.array(z.object({
  object_hash: z.string().min(1),
  source: z.string().min(1),
}))

const artifactReferenceRowsSchema = z.array(z.object({
  artifact_id: z.string().min(1),
  content_relative_path: z.string().min(1),
}))

export interface RuntimeIntegrityCatalog {
  listObjectReferences(): Promise<ObjectReferenceRow[]>
  listArtifactReferences(): Promise<ArtifactReferenceRow[]>
}

export class PostgresRuntimeIntegrityCatalog implements RuntimeIntegrityCatalog {
  constructor(private readonly db: Pick<Database, 'execute'>) {}

  async listObjectReferences(): Promise<ObjectReferenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT sdk_state_content_hash AS object_hash, 'run:' || run_id AS source
      FROM platform_runs
      WHERE sdk_state_content_hash IS NOT NULL
      UNION ALL
      SELECT content_hash AS object_hash, 'thread-memory:' || thread_id || ':' || version::text AS source
      FROM platform_thread_memory_versions
    `)
    return objectReferenceRowsSchema.parse(result.rows)
  }

  async listArtifactReferences(): Promise<ArtifactReferenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT artifact_id, content_relative_path
      FROM platform_artifacts
      ORDER BY artifact_id
    `)
    return artifactReferenceRowsSchema.parse(result.rows)
  }
}

/**
 * 启动期检查结构化事实指向的外部内容。检查器只读、不修复、不删除，
 * 以免在引用关系不完整时把数据损坏误判成可自动恢复状态。
 */
export class RuntimeIntegrityChecker {
  private readonly runtimeRoot: string
  private readonly objectStore: ContentAddressedObjectStore

  constructor(
    private readonly catalog: RuntimeIntegrityCatalog,
    private readonly runtimeFiles: Pick<RuntimeFileStore, 'verifyIntegrity'>,
    runtimeRoot: string,
  ) {
    this.runtimeRoot = path.resolve(runtimeRoot)
    this.objectStore = new ContentAddressedObjectStore(path.join(this.runtimeRoot, 'objects', 'sha256'))
  }

  async verify(): Promise<void> {
    const [objectReferences, artifactReferences] = await Promise.all([
      this.catalog.listObjectReferences(),
      this.catalog.listArtifactReferences(),
    ])
    const queue = new PQueue({ concurrency: 8 })
    const failures: string[] = []

    for (const reference of objectReferences) {
      queue.add(async () => {
        try {
          if (!/^[a-f0-9]{64}$/u.test(reference.object_hash)) {
            throw new Error('不是合法 SHA256')
          }
          await this.objectStore.readByHash(reference.object_hash)
        } catch (error) {
          failures.push(`${reference.source} -> ${reference.object_hash}: ${errorMessage(error)}`)
        }
      })
    }
    for (const artifact of artifactReferences) {
      queue.add(async () => {
        try {
          await verifyArtifactPath(this.runtimeRoot, artifact)
        } catch (error) {
          failures.push(`artifact:${artifact.artifact_id}: ${errorMessage(error)}`)
        }
      })
    }
    await queue.onIdle()

    try {
      await this.runtimeFiles.verifyIntegrity()
    } catch (error) {
      failures.push(`runtime-upload: ${errorMessage(error)}`)
    }

    if (failures.length > 0) {
      throw new Error(
        `运行时数据完整性检查失败，共 ${failures.length} 项。`
        + '系统未修改任何数据；请从备份恢复缺失内容或修正数据库引用后再启动。\n'
        + failures.slice(0, 20).join('\n'),
      )
    }
  }
}

async function verifyArtifactPath(
  runtimeRoot: string,
  artifact: ArtifactReferenceRow,
): Promise<void> {
  if (!artifact.content_relative_path || path.isAbsolute(artifact.content_relative_path)) {
    throw new Error('内容路径必须是运行目录内的相对路径')
  }
  const candidate = path.resolve(runtimeRoot, artifact.content_relative_path)
  if (!isWithin(runtimeRoot, candidate)) throw new Error('内容路径越出运行目录')
  const canonical = await realpath(candidate)
  if (!isWithin(runtimeRoot, canonical)) throw new Error('内容链接越出运行目录')
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error('内容路径不是普通文件')
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
