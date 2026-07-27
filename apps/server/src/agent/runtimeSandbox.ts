// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 沙箱边界
//
//   文件:       runtimeSandbox.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 负责构造单次 run 的 sandbox manifest，并根据运行时配置选择 SDK 原生 sandbox
// backend。这里是沙箱后端选择的唯一边界，运行时编排不直接感知 Docker/本地实现细节。

import {
  dir,
  localBindMountStrategy,
  Manifest,
  mount,
  type SandboxClient,
  type SandboxPathGrantInit,
  type SandboxRunConfig,
} from '@openai/agents/sandbox'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local'
import type { RuntimeSandboxConfig } from '../schemas/types.js'

export type SandboxClientFactory = (config: RuntimeSandboxConfig) => SandboxClient

export interface SandboxArtifactMount {
  artifactId: string
  runId: string
  sourcePath: string
  sandboxPath: string
}

export interface RuntimeSandboxResources {
  artifactDirectory?: string
  artifactMounts?: readonly SandboxArtifactMount[]
}

export function buildSandboxManifest(
  options: { runId: string; sessionId: string },
  threadId: string,
  extraPathGrants: SandboxPathGrantInit[] = [],
  resources: RuntimeSandboxResources = {},
): Manifest {
  const artifactEntries = buildArtifactEntries(options.runId, resources)
  return new Manifest({
    extraPathGrants,
    entries: {
      'README.md': {
        type: 'file',
        content: `# 智能体沙箱

本工作区由平台运行时为单次智能体运行创建。

- runId: ${options.runId}
- threadId: ${threadId}
- sessionId: ${options.sessionId}

文件、shell 和 patch 操作必须在这个 sandbox 工作区内完成。平台运行时数据、上传文件和气象数据集只能通过已注册工具访问，不要猜测宿主机路径。

当前运行和同一线程中已授权的历史 Artifact 只会按资源索引给出的 \`artifacts/<runId>/<artifactId>.<ext>\` 路径只读挂载；未列出的宿主机文件不可访问。
`,
      },
      ...artifactEntries,
    },
  })
}

function buildArtifactEntries(
  currentRunId: string,
  resources: RuntimeSandboxResources,
): Record<string, ReturnType<typeof dir>> {
  const children: Record<string, ReturnType<typeof dir> | ReturnType<typeof mount>> = {}
  if (resources.artifactDirectory) {
    assertResourceId(currentRunId, '当前运行 ID')
    children[currentRunId] = mount({
      source: path.resolve(resources.artifactDirectory),
      readOnly: true,
      mountStrategy: localBindMountStrategy(),
      description: '当前运行的 Artifact 输出目录。',
    })
  }

  const historicalRuns = new Map<string, Record<string, ReturnType<typeof mount>>>()
  for (const artifact of resources.artifactMounts ?? []) {
    if (artifact.runId === currentRunId) continue
    assertResourceId(artifact.runId, 'Artifact 所属运行 ID')
    assertResourceId(artifact.artifactId, 'Artifact ID')
    const segments = artifact.sandboxPath.split('/')
    const filename = segments[2]
    if (
      segments.length !== 3
      || segments[0] !== 'artifacts'
      || segments[1] !== artifact.runId
      || !filename
      || path.posix.parse(filename).name !== artifact.artifactId
    ) {
      throw new Error(`Artifact '${artifact.artifactId}' 的沙箱路径不符合规范。`)
    }
    const runChildren = historicalRuns.get(artifact.runId) ?? {}
    const existing = runChildren[filename]
    const sourcePath = path.resolve(artifact.sourcePath)
    if (existing && existing.source !== sourcePath) {
      throw new Error(`Artifact 沙箱路径 '${artifact.sandboxPath}' 发生冲突。`)
    }
    runChildren[filename] = mount({
      source: sourcePath,
      readOnly: true,
      mountStrategy: localBindMountStrategy(),
      description: `线程历史 Artifact ${artifact.artifactId}。`,
    })
    historicalRuns.set(artifact.runId, runChildren)
  }
  for (const [runId, runChildren] of historicalRuns) {
    children[runId] = dir({
      description: '当前线程已授权的历史 Artifact。',
      children: runChildren,
    })
  }
  return Object.keys(children).length
    ? {
        artifacts: dir({
          description: '当前运行与当前线程已授权的只读 Artifact。',
          children,
        }),
      }
    : {}
}

function assertResourceId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error(`${label} 不符合沙箱路径约束。`)
}

export async function prepareRunArtifactDirectory(runtimeRoot: string, runId: string): Promise<string> {
  const root = path.resolve(runtimeRoot)
  const artifactDirectory = path.resolve(root, 'artifacts', runId)
  if (!artifactDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error('当前运行 Artifact 目录越出 runtime 根目录')
  }
  await mkdir(artifactDirectory, { recursive: true })
  return artifactDirectory
}

export function createConfiguredSandboxClient(
  config: RuntimeSandboxConfig,
): SandboxClient {
  if (config.backend === 'docker') {
    return new DockerSandboxClient({ image: config.dockerImage })
  }
  if (config.backend === 'unix_local') {
    return new UnixLocalSandboxClient()
  }
  throw new Error(`不支持的 sandbox backend：${config.backend}`)
}

export function buildSandboxRunConfig(
  manifest: Manifest,
  config: RuntimeSandboxConfig,
  factory: SandboxClientFactory = createConfiguredSandboxClient,
): SandboxRunConfig {
  const client = factory(config)
  if (client.backendId !== config.backend) {
    throw new Error(`Sandbox client backend '${client.backendId}' 与运行配置 '${config.backend}' 不匹配`)
  }
  return { client, manifest }
}
