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

export interface RuntimeSandboxResources {
  artifactDirectory?: string
}

export function buildSandboxManifest(
  options: { runId: string; sessionId: string },
  threadId: string,
  extraPathGrants: SandboxPathGrantInit[] = [],
  resources: RuntimeSandboxResources = {},
): Manifest {
  const artifactMount = resources.artifactDirectory
    ? {
        artifacts: dir({
          description: '当前运行生成的只读 Artifact。',
          children: {
            [options.runId]: mount({
              source: path.resolve(resources.artifactDirectory),
              readOnly: true,
              mountStrategy: localBindMountStrategy(),
              description: '当前运行的 Artifact 输出目录。',
            }),
          },
        }),
      }
    : {}
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
`,
      },
      ...artifactMount,
    },
  })
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
