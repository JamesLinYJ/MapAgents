// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK MCP 与 Skill 集成
//
//   文件:       runtimeSdkIntegrations.ts
//
//   日期:       2026年07月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 把 GeoForge 运行时配置转换成 OpenAI Agents SDK 原生 MCP tools 与 sandbox
// skills capability。这里是 SDK 外部能力接入的唯一边界：运行时状态机不直接拼装
// MCP server、技能目录或宿主路径授权。

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  connectMcpServers,
  createMCPToolStaticFilter,
  getAllMcpTools,
  hostedMcpTool,
  type GetAllMcpToolsOptions,
  type MCPServer,
  type MCPServersOptions,
  type Tool,
} from '@openai/agents'
import {
  dir,
  file,
  skills,
  type Capability,
  type Entry,
} from '@openai/agents/sandbox'
import type {
  AgentRuntimeConfig,
  RuntimeMcpServerConfig,
  RuntimeSkillConfig,
} from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'

interface ConnectedMcpServers {
  active: MCPServer[]
  close(): Promise<void>
}

type ConnectMcpServersFn = (
  servers: MCPServer[],
  options?: MCPServersOptions,
) => Promise<ConnectedMcpServers>

type GetMcpToolsFn = (
  options: GetAllMcpToolsOptions<AgentsExecutionContext>,
) => Promise<Tool<AgentsExecutionContext>[]>

export interface RuntimeSdkMcpFactory {
  connectMcpServers?: ConnectMcpServersFn
  getAllMcpTools?: GetMcpToolsFn
}

export interface RuntimeSdkToolIntegration {
  tools: Tool<AgentsExecutionContext>[]
  activeMcpServers: string[]
  close(): Promise<void>
}

export interface RuntimeSdkSandboxIntegration {
  capabilities: Capability[]
  pathGrants: []
  activeSkills: string[]
}

interface SkillDirectory {
  name: string
  description: string
  manifestKey: string
  entry: Entry
}

export function buildRuntimeSdkSandboxIntegration(
  config: AgentRuntimeConfig,
  options: { baseDir?: string } = {},
): RuntimeSdkSandboxIntegration {
  const skillConfig = config.sdk.skills
  if (!skillConfig.enabled) {
    return { capabilities: [], pathGrants: [], activeSkills: [] }
  }
  const skillDirectories = discoverSkillDirectories(skillConfig, options.baseDir ?? process.cwd())
  if (skillDirectories.length === 0) {
    throw new Error('已启用 SDK Skill，但没有发现可用的 SKILL.md。')
  }
  const children = Object.fromEntries(skillDirectories.map(skill => [skill.manifestKey, skill.entry]))
  return {
    capabilities: [
      skills({
        skillsPath: skillConfig.skillsPath,
        lazyFrom: {
          source: dir({ children }),
          index: skillDirectories.map(skill => ({
            name: skill.name,
            description: skill.description,
            path: skill.manifestKey,
          })),
        },
      }),
    ],
    pathGrants: [],
    activeSkills: skillDirectories.map(skill => skill.name),
  }
}

export async function createRuntimeSdkTools(
  config: AgentRuntimeConfig,
  reservedToolNames: ReadonlySet<string>,
  factory: RuntimeSdkMcpFactory = {},
): Promise<RuntimeSdkToolIntegration> {
  const mcpConfig = config.sdk.mcp
  if (!mcpConfig.enabled) {
    return emptyToolIntegration()
  }

  const connect = factory.connectMcpServers ?? connectMcpServers
  const loadTools = factory.getAllMcpTools ?? ((options) => getAllMcpTools<AgentsExecutionContext>(options))
  const tools: Tool<AgentsExecutionContext>[] = []
  const managers: ConnectedMcpServers[] = []
  const activeMcpServers: string[] = []

  for (const serverConfig of mcpConfig.servers.filter(server => server.enabled)) {
    if (serverConfig.executionMode === 'hosted') {
      tools.push(createHostedMcpTool(serverConfig) as Tool<AgentsExecutionContext>)
      activeMcpServers.push(serverConfig.name)
      continue
    }

    const manager = await connect(
      [createMcpServer(serverConfig)],
      {
        strict: true,
        dropFailed: false,
        connectTimeoutMs: mcpConfig.connectTimeoutMs,
        closeTimeoutMs: mcpConfig.closeTimeoutMs,
        connectInParallel: false,
      },
    )
    if (manager.active.length !== 1) {
      await manager.close()
      throw new Error(`MCP server '${serverConfig.name}' 未能建立活动连接。`)
    }
    managers.push(manager)
    activeMcpServers.push(serverConfig.name)
    const serverTools = await loadTools({
      mcpServers: manager.active,
      convertSchemasToStrict: serverConfig.convertSchemasToStrict,
      includeServerInToolNames: serverConfig.includeServerInToolNames,
      reservedToolNames: new Set(reservedToolNames),
      errorFunction: null,
    })
    for (const tool of serverTools) {
      tools.push(applyMcpApprovalPolicy(tool, serverConfig))
    }
  }

  return {
    tools,
    activeMcpServers,
    close: async () => {
      await Promise.all(managers.map(manager => manager.close()))
    },
  }
}

function emptyToolIntegration(): RuntimeSdkToolIntegration {
  return {
    tools: [],
    activeMcpServers: [],
    close: async () => {},
  }
}

function createMcpServer(config: RuntimeMcpServerConfig): MCPServer {
  const common = {
    name: config.name,
    cacheToolsList: config.cacheToolsList,
    timeout: config.timeoutMs,
    toolFilter: createMCPToolStaticFilter({
      allowed: config.allowedTools.length ? config.allowedTools : undefined,
      blocked: config.blockedTools.length ? config.blockedTools : undefined,
    }),
    useStructuredContent: config.useStructuredContent,
    errorFunction: null,
  }
  if (config.transport === 'streamable_http') {
    return new MCPServerStreamableHttp({
      ...common,
      url: requireHttpUrl(config),
      requestInit: { headers: resolveMcpHeaders(config) },
    })
  }
  if (config.transport === 'sse') {
    return new MCPServerSSE({
      ...common,
      url: requireHttpUrl(config),
      requestInit: { headers: resolveMcpHeaders(config) },
    })
  }
  return new MCPServerStdio({
    ...common,
    command: requireNonEmpty(config.command, `MCP server '${config.name}' 缺少 command。`),
    args: config.args,
    cwd: config.cwd ?? undefined,
    env: config.env,
  })
}

function createHostedMcpTool(config: RuntimeMcpServerConfig): Tool {
  const headers = resolveMcpHeaders(config)
  const allowedTools = config.allowedTools.length ? { toolNames: config.allowedTools } : undefined
  if (config.connectorId?.trim()) {
    if (config.approval === 'never') {
      return hostedMcpTool({
        serverLabel: config.name,
        connectorId: config.connectorId.trim(),
        authorization: resolveMcpAuthorization(config),
        headers,
        allowedTools,
        serverDescription: config.description || undefined,
        requireApproval: 'never',
      })
    }
    return hostedMcpTool({
      serverLabel: config.name,
      connectorId: config.connectorId.trim(),
      authorization: resolveMcpAuthorization(config),
      headers,
      allowedTools,
      serverDescription: config.description || undefined,
      requireApproval: 'always',
    })
  }
  if (config.approval === 'never') {
    return hostedMcpTool({
      serverLabel: config.name,
      serverUrl: requireHttpUrl(config),
      authorization: resolveMcpAuthorization(config),
      headers,
      allowedTools,
      serverDescription: config.description || undefined,
      requireApproval: 'never',
    })
  }
  return hostedMcpTool({
    serverLabel: config.name,
    serverUrl: requireHttpUrl(config),
    authorization: resolveMcpAuthorization(config),
    headers,
    allowedTools,
    serverDescription: config.description || undefined,
    requireApproval: 'always',
  })
}

function applyMcpApprovalPolicy(
  tool: Tool<AgentsExecutionContext>,
  config: RuntimeMcpServerConfig,
): Tool<AgentsExecutionContext> {
  if (tool.type !== 'function' || config.approval === 'never') return tool
  return {
    ...tool,
    needsApproval: async () => true,
  }
}

function resolveMcpHeaders(config: RuntimeMcpServerConfig): Record<string, string> {
  const headers = { ...config.headers }
  const authorization = resolveMcpAuthorization(config)
  if (authorization && !headers.Authorization && !headers.authorization) {
    headers.Authorization = authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`
  }
  return headers
}

function resolveMcpAuthorization(config: RuntimeMcpServerConfig): string | undefined {
  if (!config.authorizationEnv) return undefined
  const value = process.env[config.authorizationEnv]?.trim()
  if (!value) throw new Error(`MCP server '${config.name}' 的授权环境变量 '${config.authorizationEnv}' 未配置。`)
  return value
}

function requireHttpUrl(config: RuntimeMcpServerConfig): string {
  const raw = requireNonEmpty(config.url, `MCP server '${config.name}' 缺少 url。`)
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`MCP server '${config.name}' 的 url 必须使用 http 或 https。`)
  }
  return parsed.toString()
}

function requireNonEmpty(value: string | null | undefined, message: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(message)
  return normalized
}

function discoverSkillDirectories(config: RuntimeSkillConfig, baseDir: string): SkillDirectory[] {
  const entries: SkillDirectory[] = []
  for (const root of config.skillRoots) {
    const absoluteRoot = resolveConfiguredHostPath(root, baseDir, false)
    if (!isDirectory(absoluteRoot)) {
      throw new Error(`Skill 根目录不存在或不是目录：${root}`)
    }
    assertNoSymlinkAncestor(absoluteRoot)
    const children = readdirSync(absoluteRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      entries.push(readSkillDirectory(path.join(absoluteRoot, child.name)))
    }
  }
  for (const skillPath of config.skillPaths) {
    entries.push(readSkillDirectory(resolveConfiguredHostPath(skillPath, baseDir, false)))
  }
  return dedupeSkills(entries)
}

function readSkillDirectory(absolutePath: string): SkillDirectory {
  if (!isDirectory(absolutePath)) {
    throw new Error(`Skill 路径不存在或不是目录：${absolutePath}`)
  }
  assertNoSymlinkAncestor(absolutePath)
  const skillFileNames = readdirSync(absolutePath).filter(entry => entry.toLowerCase() === 'skill.md')
  if (skillFileNames.length !== 1) {
    throw new Error(`Skill 目录必须包含且只能包含一个 SKILL.md：${absolutePath}`)
  }
  if (skillFileNames[0] !== 'SKILL.md') {
    throw new Error(`Skill 文件名大小写必须严格为 SKILL.md：${absolutePath}`)
  }
  const skillMarkdownPath = path.join(absolutePath, skillFileNames[0])
  if (!lstatSync(skillMarkdownPath).isFile()) {
    throw new Error(`Skill 目录中的 SKILL.md 必须是普通文件：${absolutePath}`)
  }
  const markdown = readFileSync(skillMarkdownPath, 'utf8')
  const frontmatter = parseSkillFrontmatter(markdown)
  const directoryName = path.basename(absolutePath)
  const name = frontmatter.name?.trim() || directoryName
  const manifestKey = normalizeSkillManifestKey(directoryName)
  return {
    name,
    description: frontmatter.description?.trim() || '未提供技能说明。',
    manifestKey,
    entry: buildSkillEntry(markdown, absolutePath),
  }
}

function buildSkillEntry(markdown: string, skillPath: string): Entry {
  const children: Record<string, Entry> = {
    'SKILL.md': file({ content: markdown }),
  }
  for (const childName of ['scripts', 'references', 'assets']) {
    const childPath = path.join(skillPath, childName)
    if (!pathExists(childPath)) continue
    if (!isDirectory(childPath)) {
      throw new Error(`Skill 的 ${childName}/ 必须是目录：${childPath}`)
    }
    assertNoSymlinkAncestor(childPath)
    children[childName] = readSkillAssetDirectory(childPath)
  }
  return dir({ children })
}

function readSkillAssetDirectory(absolutePath: string): Entry {
  const children: Record<string, Entry> = {}
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath = path.join(absolutePath, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill 资源目录不能包含符号链接：${childPath}`)
    }
    if (entry.isDirectory()) {
      children[entry.name] = readSkillAssetDirectory(childPath)
      continue
    }
    if (entry.isFile()) {
      children[entry.name] = file({ content: readFileSync(childPath) })
      continue
    }
    throw new Error(`Skill 资源目录只能包含普通文件和目录：${childPath}`)
  }
  return dir({ children })
}

function parseSkillFrontmatter(markdown: string): Record<string, string> {
  const lines = markdown.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return {}
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endIndex < 0) return {}
  const result: Record<string, string> = {}
  for (const line of lines.slice(1, endIndex)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key) result[key] = stripQuotes(value)
  }
  return result
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function dedupeSkills(skillsList: SkillDirectory[]): SkillDirectory[] {
  const byName = new Set<string>()
  const byKey = new Set<string>()
  const deduped: SkillDirectory[] = []
  for (const skill of skillsList) {
    if (byName.has(skill.name)) throw new Error(`Skill 名称重复：${skill.name}`)
    if (byKey.has(skill.manifestKey)) throw new Error(`Skill 目录名重复：${skill.manifestKey}`)
    byName.add(skill.name)
    byKey.add(skill.manifestKey)
    deduped.push(skill)
  }
  return deduped
}

function normalizeSkillManifestKey(value: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Skill 目录名 '${value}' 只能包含字母、数字、点、下划线和连字符。`)
  }
  return normalized
}

function resolveConfiguredHostPath(input: string, baseDir: string, allowRelativeEscape: boolean): string {
  if (input.includes('\0')) throw new Error('路径不能包含空字节。')
  const resolvedBase = path.resolve(baseDir)
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(resolvedBase, input)
  if (!path.isAbsolute(input) && !allowRelativeEscape && !isPathWithinRoot(resolvedBase, resolved)) {
    throw new Error(`相对路径不能逃逸项目根目录：${input}`)
  }
  return resolved
}

function isDirectory(value: string): boolean {
  try {
    return lstatSync(value).isDirectory()
  } catch {
    return false
  }
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value)
    return true
  } catch {
    return false
  }
}

function assertNoSymlinkAncestor(value: string): void {
  let current = path.resolve(value)
  while (true) {
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Skill 路径不能包含符号链接：${value}`)
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
