// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 固定 Docker Compose 项目边界
//
//   文件:       dockerComposeProject.ts
//
//   日期:       2026年07月27日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

const composePublisherSchema = z.object({
  URL: z.string(),
  TargetPort: z.number().int().nonnegative(),
  PublishedPort: z.number().int().nonnegative(),
  Protocol: z.string().min(1),
}).passthrough()

const composeProcessSchema = z.object({
  ID: z.string().min(1),
  Labels: z.string().default(''),
  Name: z.string().min(1),
  Publishers: z.array(composePublisherSchema).nullish().transform(value => value ?? []),
  Service: z.string().min(1),
  State: z.string().min(1),
}).passthrough()

export type ComposeProcess = z.infer<typeof composeProcessSchema>

const INFRA_SERVICES = new Set(['postgis', 'martin', 'titiler'])
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files'

export interface ComposePort {
  environmentName: string
  port: number
}

export interface ComposePortOwnership {
  owned: boolean
  message: string
}

export function composeFileFor(projectRoot: string, profile: OperationsProfile): string {
  return path.join(
    projectRoot,
    'infra',
    'compose',
    profile === 'production' ? 'docker-compose.prod.yml' : 'docker-compose.dev.yml',
  )
}

/**
 * 只查询由固定 Compose 文件解析出的项目。调用方仍须用
 * verifyComposePortOwnership 校验容器标签，不能仅凭 Compose 项目名认领端口。
 */
export async function listComposeProcesses(input: {
  projectRoot: string
  profile: OperationsProfile
  environment: NodeJS.ProcessEnv
}): Promise<ComposeProcess[]> {
  const composeFile = composeFileFor(input.projectRoot, input.profile)
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeFile, 'ps', '--format', 'json'],
    {
      cwd: input.projectRoot,
      env: input.environment,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  )
  return parseComposeProcesses(stdout)
}

/**
 * Docker Desktop 会在系统启动后恢复 restart: unless-stopped 容器。监督器可以
 * 重新接管这些容器，但只能在配置文件、服务名、运行状态和发布端口全部吻合时认领。
 */
export function verifyComposePortOwnership(input: {
  composeFile: string
  occupiedPorts: readonly ComposePort[]
  processes: readonly ComposeProcess[]
}): ComposePortOwnership {
  const expectedComposeFile = normalizePath(input.composeFile)
  const ownedProcesses = input.processes.filter(processInfo => {
    const configFiles = labelValue(processInfo.Labels, CONFIG_FILES_LABEL)
    return (
      INFRA_SERVICES.has(processInfo.Service)
      && processInfo.State.toLowerCase() === 'running'
      && configFiles !== null
      && normalizePath(configFiles) === expectedComposeFile
    )
  })

  for (const occupied of input.occupiedPorts) {
    const owner = ownedProcesses.find(processInfo => processInfo.Publishers.some(publisher => (
      publisher.Protocol.toLowerCase() === 'tcp'
      && publisher.PublishedPort === occupied.port
    )))
    if (!owner) {
      return {
        owned: false,
        message: `${occupied.environmentName} 端口 ${occupied.port} 不属于当前 GeoForge Compose 项目。`,
      }
    }
  }

  return {
    owned: true,
    message: `已核验 ${input.occupiedPorts.length} 个端口属于当前 GeoForge Compose 项目。`,
  }
}

export function parseComposeProcesses(value: string): ComposeProcess[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return z.array(composeProcessSchema).parse(Array.isArray(parsed) ? parsed : [parsed])
  } catch {
    return trimmed
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => composeProcessSchema.parse(JSON.parse(line)))
  }
}

function labelValue(labels: string, name: string): string | null {
  const prefix = `${name}=`
  const entry = labels.split(',').find(candidate => candidate.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : null
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
