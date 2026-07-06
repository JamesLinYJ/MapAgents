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
  Manifest,
  type SandboxSessionLike,
} from '@openai/agents/sandbox'
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local'
import type { RuntimeSandboxConfig } from '../schemas/types.js'

export type SandboxSessionFactory = (
  manifest: Manifest,
  config: RuntimeSandboxConfig,
) => Promise<SandboxSessionLike>

export interface OpenAIAgentsRuntimeOptions {
  createSandboxSession?: SandboxSessionFactory
}

export function buildSandboxManifest(
  options: { runId: string; sessionId: string },
  threadId: string,
): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# GeoForge Sandbox

本工作区由 GeoForge 运行时为单次 Agent run 创建。

- runId: ${options.runId}
- threadId: ${threadId}
- sessionId: ${options.sessionId}

文件、shell 和 patch 操作必须在这个 sandbox 工作区内完成。平台运行时数据、上传文件和气象数据集只能通过已注册工具访问，不要猜测宿主机路径。
`,
      },
    },
  })
}

export async function createConfiguredSandboxSession(
  manifest: Manifest,
  config: RuntimeSandboxConfig,
): Promise<SandboxSessionLike> {
  if (config.backend === 'docker') {
    return new DockerSandboxClient({ image: config.dockerImage }).create(manifest)
  }
  if (config.backend === 'unix_local') {
    return new UnixLocalSandboxClient().create(manifest)
  }
  throw new Error(`不支持的 sandbox backend：${config.backend}`)
}
