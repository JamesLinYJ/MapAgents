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
// 把 平台 运行时配置转换成 OpenAI Agents SDK 原生 MCP tools 与 sandbox
// skills capability。这里是 SDK 外部能力接入的唯一边界：运行时状态机不直接拼装
// MCP server、技能目录或宿主路径授权。

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
import type { SkillMatchResult } from '@geo-agent-platform/shared-types/resources'
import {
  Capability,
  dir,
  skills,
} from '@openai/agents/sandbox'
import type {
  AgentRuntimeConfig,
  RuntimeMcpServerConfig,
} from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { RunToolConcurrencyGate } from './runToolConcurrencyGate.js'
import {
  buildSkillRegistry,
  buildSkillSandboxEntry,
  explicitSkillIds,
  selectRuntimeSkills,
} from './skillRegistry.js'

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
  mcpToolServers: ReadonlyMap<string, string>
  activeMcpServers: string[]
  close(): Promise<void>
}

export interface RuntimeSdkSandboxIntegration {
  capabilities: Capability[]
  pathGrants: []
  activeSkills: string[]
  skillMatches: SkillMatchResult[]
}

export function buildRuntimeSdkSandboxIntegration(
  config: AgentRuntimeConfig,
  options: {
    baseDir?: string
    executionGate?: RunToolConcurrencyGate
    query?: string
  } = {},
): RuntimeSdkSandboxIntegration {
  const skillConfig = config.sdk.skills
  if (!skillConfig.enabled) {
    const explicitlyRequested = options.query ? explicitSkillIds(options.query) : []
    if (explicitlyRequested.length) {
      throw new Error(`用户显式指定了 Skill '/${explicitlyRequested[0]}'，但 Skill 总开关已关闭。`)
    }
    return { capabilities: [], pathGrants: [], activeSkills: [], skillMatches: [] }
  }
  if (config.sandbox.backend === 'disabled') {
    throw new Error('SDK Skill 依赖沙箱工作区；当前平台已禁用沙箱，不能启用 Skill。')
  }
  const registry = buildSkillRegistry(skillConfig, options.baseDir ?? process.cwd())
  const selection = options.query === undefined
    ? {
        selected: registry.skills.filter(skill => skill.catalog.active),
        matches: [] as SkillMatchResult[],
      }
    : selectRuntimeSkills(options.query, registry)
  if (selection.selected.length === 0) {
    return { capabilities: [], pathGrants: [], activeSkills: [], skillMatches: selection.matches }
  }
  const children = Object.fromEntries(selection.selected.map(skill => [skill.manifestKey, buildSkillSandboxEntry(skill)]))
  const createSkillsCapability = () => skills({
    skillsPath: skillConfig.skillsPath,
    lazyFrom: {
      source: dir({ children }),
      index: selection.selected.map(skill => ({
        name: skill.catalog.skillId,
        description: skill.catalog.description,
        path: skill.manifestKey,
      })),
    },
  })
  return {
    capabilities: [
      new SkillLoadingCapability(
        createSkillsCapability,
        options.executionGate ?? new RunToolConcurrencyGate(),
      ),
    ],
    pathGrants: [],
    activeSkills: selection.selected.map(skill => skill.catalog.skillId),
    skillMatches: selection.matches,
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
  const mcpToolServers = new Map<string, string>()
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
      const appendedNames = appendUniqueFunctionTools(
        tools,
        serverTools.map(tool => applyMcpExecutionPolicy(
          applyMcpApprovalPolicy(applyMcpOutputMetadata(tool, serverConfig), serverConfig),
          executionGate,
        )),
        exposedFunctionToolNames,
      )
      for (const toolName of appendedNames) mcpToolServers.set(toolName, serverConfig.name)
    }

    return {
      tools,
      mcpToolNames: new Set(tools.filter(tool => tool.type === 'function').map(tool => tool.name)),
      mcpToolServers,
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

// load_skill 只把已配置的 Skill 快照物化到当前 run 沙箱，不访问外部系统，
// 也不授予 Skill 后续工具权限。它应在规划和执行阶段保持可用；Skill 内真正
// 产生副作用的操作仍由平台工具、MCP 与沙箱各自的执行边界决定。
class SkillLoadingCapability extends Capability {
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
    return serializeSkillLoading(this.boundCapability().tools(), this.executionGate)
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

function serializeSkillLoading<TContext>(
  tools: Tool<TContext>[],
  executionGate: RunToolConcurrencyGate,
): Tool<TContext>[] {
  return tools.map(tool => {
    if (tool.type !== 'function') return tool
    const invoke: typeof tool.invoke = async (runContext, input, details) => {
      return executionGate.run('exclusive', () => tool.invoke(runContext, input, details))
    }
    return { ...tool, invoke }
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
    mcpToolServers: new Map(),
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
): string[] {
  const appendedNames: string[] = []
  for (const tool of additions) {
    if (tool.type === 'function') {
      if (exposedNames.has(tool.name)) throw new Error(`MCP 工具名 '${tool.name}' 与已公开工具重名`)
      exposedNames.add(tool.name)
    }
    target.push(tool)
    appendedNames.push(tool.name)
  }
  return appendedNames
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
