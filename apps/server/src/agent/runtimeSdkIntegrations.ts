// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK MCP 与 Skill 集成
//
//   文件:       runtimeSdkIntegrations.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
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
  type Agent,
  type FunctionToolCustomDataContext,
  type GetAllMcpToolsOptions,
  type MCPServer,
  type MCPServersOptions,
  type RunContext,
  type Tool,
} from '@openai/agents'
import {
  agentToolOutputMetadataSchema,
} from '@geo-agent-platform/shared-types/runtime'
import {
  Capability,
  dir,
  file,
  skills,
  type Entry,
} from '@openai/agents/sandbox'
import type {
  AgentRuntimeConfig,
  RuntimeMcpServerConfig,
  RuntimeSkillConfig,
} from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { RunToolConcurrencyGate } from './runToolConcurrencyGate.js'

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

export interface RuntimeSdkIntegration {
  tools: Tool<AgentsExecutionContext>[]
  mcpToolNames: ReadonlySet<string>
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
  options: {
    baseDir?: string
    executionGate?: RunToolConcurrencyGate
  } = {},
): RuntimeSdkSandboxIntegration {
  const skillConfig = config.sdk.skills
  if (!skillConfig.enabled) {
    return { capabilities: [], pathGrants: [], activeSkills: [] }
  }
  if (config.sandbox.backend === 'disabled') {
    throw new Error('SDK Skill 依赖沙箱工作区；当前平台已禁用沙箱，不能启用 Skill。')
  }
  const skillDirectories = discoverSkillDirectories(skillConfig, options.baseDir ?? process.cwd())
  if (skillDirectories.length === 0) {
    throw new Error('已启用 SDK Skill，但没有发现可用的 SKILL.md。')
  }
  const children = Object.fromEntries(skillDirectories.map(skill => [skill.manifestKey, skill.entry]))
  const createSkillsCapability = () => skills({
    skillsPath: skillConfig.skillsPath,
    lazyFrom: {
      source: dir({ children }),
      index: skillDirectories.map(skill => ({
        name: skill.name,
        description: skill.description,
        path: skill.manifestKey,
      })),
    },
  })
  return {
    capabilities: [
      new ExecutionGatedCapability(
        createSkillsCapability,
        options.executionGate ?? new RunToolConcurrencyGate(),
      ),
    ],
    pathGrants: [],
    activeSkills: skillDirectories.map(skill => skill.name),
  }
}

export async function createRuntimeSdkIntegration(
  config: AgentRuntimeConfig,
  reservedToolNames: ReadonlySet<string>,
  executionGate: RunToolConcurrencyGate,
  factory: RuntimeSdkMcpFactory = {},
): Promise<RuntimeSdkIntegration> {
  const mcpConfig = config.sdk.mcp
  if (!mcpConfig.enabled) {
    return emptyToolIntegration()
  }

  const connect = factory.connectMcpServers ?? connectMcpServers
  const loadTools = factory.getAllMcpTools ?? ((options) => getAllMcpTools<AgentsExecutionContext>(options))
  const tools: Tool<AgentsExecutionContext>[] = []
  const managers: ConnectedMcpServers[] = []
  const activeMcpServers: string[] = []
  const exposedFunctionToolNames = new Set(reservedToolNames)

  try {
    for (const serverConfig of mcpConfig.servers.filter(server => server.enabled)) {
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
        reservedToolNames: new Set(exposedFunctionToolNames),
        errorFunction: null,
      })
      appendUniqueFunctionTools(
        tools,
        serverTools.map(tool => applyMcpExecutionPolicy(
          applyMcpApprovalPolicy(applyMcpOutputMetadata(tool, serverConfig), serverConfig),
          executionGate,
        )),
        exposedFunctionToolNames,
      )
    }

    return {
      tools,
      mcpToolNames: new Set(tools.filter(tool => tool.type === 'function').map(tool => tool.name)),
      activeMcpServers,
      close: async () => {
        await Promise.all(managers.map(manager => manager.close()))
      },
    }
  } catch (error) {
    await Promise.allSettled(managers.map(manager => manager.close()))
    throw error
  }
}

// Capability 是 SDK 的公开扩展边界。Skill 的 load_skill 工具由 Capability
// 在 sandbox 绑定后生成，因此要在这一层同时包住可见性与执行，而不是在
// Agent 装配后修改 SDK 内部对象。这样运行中切入计划模式也会立即失效。
class ExecutionGatedCapability extends Capability {
  readonly type: string
  private modelName = ''

  constructor(
    private readonly createCapability: () => Capability,
    private readonly executionGate: RunToolConcurrencyGate,
  ) {
    super()
    this.type = createCapability().type
  }

  override bindModel(
    model: Parameters<Capability['bindModel']>[0],
    modelInstance?: Parameters<Capability['bindModel']>[1],
  ): this {
    this.modelName = model
    return super.bindModel(model, modelInstance)
  }

  override requiredCapabilityTypes(): Set<string> {
    return this.boundCapability().requiredCapabilityTypes()
  }

  override tools(): Tool<unknown>[] {
    return gateSdkExtensionTools(this.boundCapability().tools(), this.executionGate)
  }

  override processManifest(
    manifest: Parameters<Capability['processManifest']>[0],
  ): ReturnType<Capability['processManifest']> {
    return this.boundCapability().processManifest(manifest)
  }

  override instructions(
    manifest: Parameters<Capability['instructions']>[0],
  ): ReturnType<Capability['instructions']> {
    return this.boundCapability().instructions(manifest)
  }

  override samplingParams(
    params: Parameters<Capability['samplingParams']>[0],
  ): ReturnType<Capability['samplingParams']> {
    return this.boundCapability().samplingParams(params)
  }

  override processContext(
    context: Parameters<Capability['processContext']>[0],
  ): ReturnType<Capability['processContext']> {
    return this.boundCapability().processContext(context)
  }

  private boundCapability(): Capability {
    const capability = this.createCapability()
    if (this._session) capability.bind(this._session)
    capability.bindRunAs(this._runAs)
    capability.bindModel(this.modelName, this._modelInstance)
    return capability
  }
}

function gateSdkExtensionTools<TContext>(
  tools: Tool<TContext>[],
  executionGate: RunToolConcurrencyGate,
): Tool<TContext>[] {
  return tools.map(tool => {
    if (tool.type !== 'function') return tool
    const isEnabled: typeof tool.isEnabled = async (runContext, agent) => {
      const context = runContext.context as unknown as Partial<AgentsExecutionContext>
      const enabled = typeof context.isSdkExtensionEnabled === 'function'
        && context.isSdkExtensionEnabled()
      if (!enabled) return false
      return tool.isEnabled(runContext, agent)
    }
    const invoke: typeof tool.invoke = async (runContext, input, details) => {
      const context = runContext.context as unknown as Partial<AgentsExecutionContext>
      const enabled = typeof context.isSdkExtensionEnabled === 'function'
        && context.isSdkExtensionEnabled()
      if (!enabled) throw new Error(`当前规划或结构化工作流边界禁止调用 SDK Skill 工具 '${tool.name}'。`)
      return executionGate.run('exclusive', () => tool.invoke(runContext, input, details))
    }
    return { ...tool, isEnabled, invoke }
  })
}

function applyMcpExecutionPolicy(
  tool: Tool<AgentsExecutionContext>,
  executionGate: RunToolConcurrencyGate,
): Tool<AgentsExecutionContext> {
  if (tool.type !== 'function') return tool
  const isEnabled = async (
    runContext: RunContext<AgentsExecutionContext>,
    agent: Agent<AgentsExecutionContext>,
  ): Promise<boolean> => (
    runContext.context.isSdkExtensionEnabled() && tool.isEnabled(runContext, agent)
  )
  const invoke: typeof tool.invoke = async (runContext, input, details) => {
    if (!runContext.context.isSdkExtensionEnabled()) {
      throw new Error(`当前规划或结构化工作流边界禁止调用 MCP 工具 '${tool.name}'。`)
    }
    return executionGate.run('exclusive', () => tool.invoke(runContext, input, details))
  }
  return { ...tool, isEnabled, invoke }
}

function emptyToolIntegration(): RuntimeSdkIntegration {
  return {
    tools: [],
    mcpToolNames: new Set(),
    activeMcpServers: [],
    close: async () => {},
  }
}

function createMcpServer(config: RuntimeMcpServerConfig): MCPServer {
  const filterConfig = {
    ...(config.allowedTools.length ? { allowed: config.allowedTools } : {}),
    ...(config.blockedTools.length ? { blocked: config.blockedTools } : {}),
  }
  const toolFilter = Object.keys(filterConfig).length
    ? createMCPToolStaticFilter(filterConfig)
    : undefined
  const common = {
    name: config.name,
    cacheToolsList: config.cacheToolsList,
    timeout: config.timeoutMs,
    ...(toolFilter ? { toolFilter } : {}),
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
    ...(config.cwd ? { cwd: config.cwd } : {}),
    env: config.env,
  })
}

function appendUniqueFunctionTools(
  target: Tool<AgentsExecutionContext>[],
  additions: Tool<AgentsExecutionContext>[],
  exposedNames: Set<string>,
): void {
  for (const tool of additions) {
    if (tool.type === 'function') {
      if (exposedNames.has(tool.name)) throw new Error(`MCP 工具名 '${tool.name}' 与已公开工具重名`)
      exposedNames.add(tool.name)
    }
    target.push(tool)
  }
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

function applyMcpOutputMetadata(
  tool: Tool<AgentsExecutionContext>,
  config: RuntimeMcpServerConfig,
): Tool<AgentsExecutionContext> {
  if (tool.type !== 'function') return tool
  return {
    ...tool,
    customDataExtractor: ({ toolCall }: FunctionToolCustomDataContext<AgentsExecutionContext>) => agentToolOutputMetadataSchema.parse({
      schemaVersion: 1,
      callId: toolCall.callId,
      toolName: tool.name,
      resultId: null,
      valueRefIds: [],
      artifactIds: [],
      display: {
        label: tool.name,
        summary: null,
        source: `mcp:${config.name}`,
      },
    }),
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
