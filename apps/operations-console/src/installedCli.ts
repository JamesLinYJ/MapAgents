// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux 安装版统一命令行
//
//   文件:       installedCli.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import {
  preparePackagedLocalRuntime,
} from '@geo-agent-platform/operations-supervisor/packaged-local-runtime'
import { resolveOperationsPaths } from '@geo-agent-platform/operations-supervisor'
import {
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { parse as parseDotEnv } from 'dotenv'

const USER_SERVICE_NAME = 'geo-agent-platform-supervisor.service'
const SYSTEM_RUNTIME_MANIFEST = '/etc/geo-agent-platform/runtime-manifest.v1.json'
const SUPERVISOR_READY_TIMEOUT_MS = 30_000

export type InstalledCliCommand =
  | { kind: 'agent'; arguments: string[] }
  | { kind: 'console'; arguments: string[] }
  | { kind: 'desktop' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'supervisor'; command: 'status' | 'logs'; arguments: string[] }
  | { kind: 'start' }

export interface InstalledCliDependencies {
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  homeDirectory: string
  ownerUid?: number
  stdout: Pick<NodeJS.WriteStream, 'write'>
  stderr: Pick<NodeJS.WriteStream, 'write'>
  runChild: (executable: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv) => Promise<number>
  launchDesktop: () => Promise<void>
  now: () => number
  delay: (milliseconds: number) => Promise<void>
}

export async function runInstalledCli(
  argv: readonly string[],
  dependencies: InstalledCliDependencies = productionDependencies(),
): Promise<number> {
  const command = parseInstalledCli(argv)
  if (command.kind === 'help') {
    dependencies.stdout.write(installedCliHelpText())
    return 0
  }
  if (command.kind === 'version') {
    const packageJson: unknown = JSON.parse(await readFile(
      path.join(dependencies.runtimeRoot, 'package.json'),
      'utf8',
    ))
    const version = typeof packageJson === 'object' && packageJson !== null
      && 'version' in packageJson && typeof packageJson.version === 'string'
      ? packageJson.version
      : 'unknown'
    dependencies.stdout.write(`${PRODUCT_CODENAME} ${version}\n`)
    return 0
  }
  if (command.kind === 'desktop') {
    await dependencies.launchDesktop()
    return 0
  }

  const environmentFile = await prepareInstalledRuntime(dependencies)
  Object.assign(dependencies.environment, parseDotEnv(await readFile(environmentFile, 'utf8')))
  dependencies.environment.NODE_ENV = 'production'
  dependencies.environment.GEO_AGENT_PLATFORM_ROOT = dependencies.runtimeRoot

  const supervisor = await connectSupervisor(dependencies)
  try {
    if (command.kind === 'start') {
      await startApi(supervisor)
      dependencies.stdout.write(`${PRODUCT_DESKTOP_NAME} 后端已就绪。\n`)
      return 0
    }
    if (command.kind === 'supervisor') {
      supervisor.close()
      return dependencies.runChild(
        process.execPath,
        [
          path.join(dependencies.runtimeRoot, 'packages', 'operations-supervisor', 'dist', 'cli.js'),
          command.command,
          ...command.arguments,
          '--root', dependencies.runtimeRoot,
          '--profile', 'production',
        ],
        dependencies.environment,
      )
    }
    await startApi(supervisor)
  } finally {
    supervisor.close()
  }

  const entry = command.kind === 'console'
    ? path.join(dependencies.runtimeRoot, 'apps', 'operations-console', 'dist', 'localConsoleEntry.js')
    : path.join(
        dependencies.runtimeRoot,
        'apps',
        'operations-console',
        'dist',
        'agent',
        'cli',
        'localAgentConsoleEntry.js',
      )
  return dependencies.runChild(process.execPath, [entry, ...command.arguments], dependencies.environment)
}

export function parseInstalledCli(argv: readonly string[]): InstalledCliCommand {
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' }
  if (first === '--version' || first === '-V' || first === 'version') return { kind: 'version' }
  if (first === 'agent') return { kind: 'agent', arguments: rest }
  if (first === 'console') return { kind: 'console', arguments: rest }
  if (first === 'desktop') return { kind: 'desktop' }
  if (first === 'start') return { kind: 'start' }
  if (first === 'status' || first === 'logs') {
    return { kind: 'supervisor', command: first, arguments: rest }
  }
  // `geoforge` 和 `geoforge -p "..."` 都直接进入 Agent，保持最短使用路径。
  return { kind: 'agent', arguments: [...argv] }
}

export function installedCliHelpText(): string {
  return [
    `${PRODUCT_CODENAME} 安装版命令行`,
    '',
    '用法：',
    '  geoforge                         自动启动后端并进入交互式 Agent',
    '  geoforge -p "分析杭州降雨"       执行一次任务',
    '  geoforge agent [参数]            Agent 完整参数',
    '  geoforge console                 打开本机运维台',
    '  geoforge start                   部署并启动本机后端',
    '  geoforge status                  查看后端状态',
    '  geoforge logs [服务]             查看后端日志',
    '  geoforge desktop                 打开桌面工作台',
    '  geoforge --version               显示版本',
    '',
    '首次运行会自动创建当前用户的 PostgreSQL、Worker、API 配置并启动 systemd 用户服务。',
    '无需 Docker，也无需进入源码目录。',
    '',
  ].join('\n')
}

async function prepareInstalledRuntime(dependencies: InstalledCliDependencies): Promise<string> {
  const resolution = await preparePackagedLocalRuntime({
    platform: process.platform,
    resourcesPath: path.dirname(dependencies.runtimeRoot),
    homeDirectory: dependencies.homeDirectory,
    environment: dependencies.environment,
    ...(dependencies.ownerUid === undefined ? {} : { ownerUid: dependencies.ownerUid }),
    systemRuntimeManifestPath: SYSTEM_RUNTIME_MANIFEST,
  })
  if (resolution) return resolution.serviceEnvironmentFile

  const configHome = dependencies.environment.XDG_CONFIG_HOME?.trim()
    || path.join(dependencies.homeDirectory, '.config')
  const environmentFile = path.join(configHome, PLATFORM_TECHNICAL_ID, 'runtime.env')
  try {
    await readFile(environmentFile, 'utf8')
    return environmentFile
  } catch {
    throw new Error('未找到可用的本机运行时配置；请检查 RPM 运行时或系统部署清单。')
  }
}

async function connectSupervisor(dependencies: InstalledCliDependencies): Promise<OperationsClient> {
  const projectRoot = dependencies.runtimeRoot
  const environment = dependencies.environment
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile: 'production',
    ...(environment.RUNTIME_ROOT ? { runtimeRoot: environment.RUNTIME_ROOT } : {}),
    ...(environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE
      ? { tokenFile: environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE }
      : {}),
    ...(environment.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE
      ? { rootSecretFile: environment.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE }
      : {}),
  })
  const deadline = dependencies.now() + SUPERVISOR_READY_TIMEOUT_MS
  let lastError: unknown = null
  while (dependencies.now() < deadline) {
    try {
      const token = (await readFile(paths.tokenFile, 'utf8')).trim()
      return await OperationsClient.connect({
        endpoint: paths.endpoint,
        token,
        interactive: true,
        timeoutMs: 1_000,
      })
    } catch (error) {
      lastError = error
      await dependencies.delay(200)
    }
  }
  const reason = lastError instanceof Error ? lastError.message : '未知错误'
  throw new Error(`本机后端监督器未能就绪：${reason}`)
}

async function startApi(client: OperationsClient): Promise<void> {
  const operation = await client.operate({ action: 'start', target: 'api' })
  if (operation.outcome === 'failed') {
    throw new Error(operation.message || '本机 API 启动失败。')
  }
}

function productionDependencies(): InstalledCliDependencies {
  const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url))
  return {
    runtimeRoot,
    environment: process.env,
    homeDirectory: os.homedir(),
    ...(process.getuid ? { ownerUid: process.getuid() } : {}),
    stdout: process.stdout,
    stderr: process.stderr,
    runChild: (executable, arguments_, environment) => new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        cwd: runtimeRoot,
        env: environment,
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (signal) reject(new Error(`子进程被信号 ${signal} 终止。`))
        else resolve(code ?? 1)
      })
    }),
    launchDesktop: () => new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/geo-agent-platform-desktop', [], {
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    }),
    now: Date.now,
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

export const installedUserServiceName = USER_SERVICE_NAME
