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
const DESKTOP_EARLY_EXIT_WINDOW_MS = 1_500
const DESKTOP_MANIFEST_CONTROLLED_ENVIRONMENT = [
  'GEO_AGENT_PLATFORM_ROOT',
  'RUNTIME_ROOT',
  'APP_BASE_URL',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
] as const

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
  launchDesktop: (environment: NodeJS.ProcessEnv) => Promise<void>
  now: () => number
  delay: (milliseconds: number) => Promise<void>
}

export async function runInstalledCli(
  argv: readonly string[],
  dependencies: InstalledCliDependencies = productionDependencies(),
): Promise<number> {
  assertProductNodeRuntime(process.versions.node)
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
    assertGraphicalDesktopSession(dependencies.environment)
    await launchInstalledDesktop({
      ensureBackend: () => ensureInstalledBackend(dependencies),
      launchDesktop: () => dependencies.launchDesktop(
        createDesktopLaunchEnvironment(dependencies.environment),
      ),
    })
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

export function assertProductNodeRuntime(version: string): void {
  const major = Number(version.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`安装版需要内置 Node 24+，当前误用了 Node ${version}。请修复安装后重试。`)
  }
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
  // 无子命令和直接传 Agent 参数都进入 Agent，保持最短使用路径。
  return { kind: 'agent', arguments: [...argv] }
}

export function installedCliHelpText(): string {
  return [
    '地理智能平台安装版命令行',
    '',
    '用法：',
    '  geo-agent-platform                         自动启动后端并进入交互式 Agent',
    '  geo-agent-platform -p "分析杭州降雨"       执行一次任务',
    '  geo-agent-platform agent [参数]            Agent 完整参数',
    '  geo-agent-platform console                 打开本机运维台',
    '  geo-agent-platform start                   部署并启动本机后端',
    '  geo-agent-platform status                  查看后端状态',
    '  geo-agent-platform logs [服务]             查看后端日志',
    '  geo-agent-platform desktop                 启动后端并打开桌面工作台',
    '  geo-agent-platform --version               显示版本',
    '',
    '首次运行会自动创建当前用户的 PostgreSQL、Worker、API 配置并启动 systemd 用户服务。',
    '无需 Docker，也无需进入源码目录。',
    '',
  ].join('\n')
}

export async function launchInstalledDesktop(input: {
  ensureBackend: () => Promise<void>
  launchDesktop: () => Promise<void>
}): Promise<void> {
  await input.ensureBackend()
  await input.launchDesktop()
}

export function assertGraphicalDesktopSession(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux') return
  if (!environment.DISPLAY?.trim() && !environment.WAYLAND_DISPLAY?.trim()) {
    throw new Error('当前终端未连接图形会话；请从桌面终端运行，或从应用菜单打开工作台。')
  }
  if (!environment.DBUS_SESSION_BUS_ADDRESS?.trim() && !environment.XDG_RUNTIME_DIR?.trim()) {
    throw new Error('当前终端缺少用户会话总线；请在已登录的桌面会话中运行。')
  }
}

/**
 * 安装版桌面以受保护的 runtime manifest 为唯一运行时事实源。
 * CLI 会为后端加载 runtime.env，但这些值不能继承到 Electron，
 * 否则会被误判为用户尝试绕过 manifest 覆盖生产配置。
 */
export function createDesktopLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const desktopEnvironment = { ...environment }
  for (const name of DESKTOP_MANIFEST_CONTROLLED_ENVIRONMENT) {
    delete desktopEnvironment[name]
  }
  return desktopEnvironment
}

async function ensureInstalledBackend(dependencies: InstalledCliDependencies): Promise<void> {
  // 后端运行时环境只在这条启动链内有效；不污染随后启动的桌面进程。
  const backendDependencies: InstalledCliDependencies = {
    ...dependencies,
    environment: { ...dependencies.environment },
  }
  const environmentFile = await prepareInstalledRuntime(backendDependencies)
  Object.assign(
    backendDependencies.environment,
    parseDotEnv(await readFile(environmentFile, 'utf8')),
  )
  backendDependencies.environment.NODE_ENV = 'production'
  backendDependencies.environment.GEO_AGENT_PLATFORM_ROOT = dependencies.runtimeRoot

  const supervisor = await connectSupervisor(backendDependencies)
  try {
    await startApi(supervisor)
  } finally {
    supervisor.close()
  }
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
    launchDesktop: environment => new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/geo-agent-platform-desktop', [], {
        detached: true,
        env: environment,
        stdio: 'ignore',
      })
      let settled = false
      child.once('error', error => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        const outcome = signal ? `信号 ${signal}` : `退出码 ${code ?? 1}`
        reject(new Error(`桌面进程启动后立即终止（${outcome}）。`))
      })
      child.once('spawn', () => {
        setTimeout(() => {
          if (settled) return
          settled = true
          child.unref()
          resolve()
        }, DESKTOP_EARLY_EXIT_WINDOW_MS)
      })
    }),
    now: Date.now,
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

export const installedUserServiceName = USER_SERVICE_NAME
